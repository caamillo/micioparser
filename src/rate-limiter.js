import log from "./log.js"

/**
 * Rate limiter with automatic or manual configuration
 */
export function RateLimiter(config = {}) {
    const state = {
        mode: config.mode || 'auto', // 'auto' || 'manual'
        reqsPerSecond: config.reqsPerSecond || null,
        intervalMs: 0,
        lastRequestTime: 0,
        queue: [],
        processing: false,
        stats: null, // Will hold auto-detected stats
        isConfigured: false
    }

    // Calculate interval based on rate
    const updateInterval = () => {
        if (state.reqsPerSecond === null || state.reqsPerSecond === Infinity) {
            state.intervalMs = 0
            state.isConfigured = false
        } else {
            state.intervalMs = 1000 / state.reqsPerSecond
            state.isConfigured = true
        }
    }

    updateInterval()

    const processQueue = async () => {
        if (state.processing || state.queue.length === 0) return
        
        state.processing = true
        const now = Date.now()
        const timeSinceLastRequest = now - state.lastRequestTime
        const waitTime = Math.max(0, state.intervalMs - timeSinceLastRequest)
        
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime))
        }
        
        state.lastRequestTime = Date.now()
        const resolve = state.queue.shift()
        state.processing = false
        
        resolve()
        
        if (state.queue.length > 0) {
            processQueue()
        }
    }

    return {
        // Throttle a request
        throttle: async () => {
            if (!state.isConfigured || state.mode === 'auto' && !state.stats) {
                // No throttling if not configured or auto mode not tested yet
                return
            }

            return new Promise((resolve) => {
                state.queue.push(resolve)
                processQueue()
            })
        },

        // Set manual rate limit
        setRate: (reqsPerSecond) => {
            state.mode = 'manual'
            state.reqsPerSecond = reqsPerSecond
            updateInterval()
            log.info('Rate limit set to manual', { 
                reqsPerSecond: reqsPerSecond === Infinity ? 'unlimited' : reqsPerSecond 
            })
        },

        // Configure from auto-test results
        configureFromStats: (stats) => {
            if (state.mode !== 'auto') {
                log.warn('Rate limiter is in manual mode, ignoring auto-configuration')
                return
            }
            state.stats = stats
            state.reqsPerSecond = parseFloat(stats.recommendedReqsPerSecond)
            updateInterval()
            log.success('Rate limiter auto-configured', {
                reqsPerSecond: state.reqsPerSecond.toFixed(2),
                basedOn: 'auto-test'
            })
        },

        // Get current configuration
        getConfig: () => ({
            mode: state.mode,
            reqsPerSecond: state.reqsPerSecond,
            intervalMs: state.intervalMs,
            isConfigured: state.isConfigured,
            queueLength: state.queue.length,
            stats: state.stats ? {
                totalRequests: state.stats.totalRequests,
                successfulRequests: state.stats.successfulRequests,
                recommendedReqsPerSecond: state.stats.recommendedReqsPerSecond,
                avgResponseTime: state.stats.avgResponseTime
            } : null
        }),

        // Check if rate limiter is ready
        isReady: () => state.isConfigured,

        // Reset to auto mode
        resetToAuto: () => {
            state.mode = 'auto'
            state.reqsPerSecond = null
            state.stats = null
            updateInterval()
            log.info('Rate limiter reset to auto mode')
        }
    }
}

/**
 * Test rate limits for a connector
 */
export async function RateLimitTester(driver, options = {}) {
    const config = {
        testDuration: options.testDuration || 60e3,
        initialRate: options.initialRate || 30,
        rateIncrement: options.rateIncrement || 30,
        maxRate: options.maxRate || 100,
        failureThreshold: options.failureThreshold || 3,
        testUrl: options.testUrl || driver.getSearchUrl('GTO').render(),
        sustainedRate: options.sustainedRate || null,
        ...options
    }

    log.info('Starting rate limit test', {
        connector: driver.name,
        mode: config.sustainedRate ? 'sustained' : 'progressive',
        ...config
    })

    const results = []

    // Test single request
    const testRequest = async (url) => {
        const start = Date.now()
        try {
            const response = await driver.page.goto(url, { 
                timeout: 10000,
                waitUntil: 'domcontentloaded' 
            })
            
            return {
                timestamp: start,
                duration: Date.now() - start,
                success: response.ok(),
                status: response.status()
            }
        } catch (error) {
            return {
                timestamp: start,
                duration: Date.now() - start,
                success: false,
                error: error.message
            }
        }
    }

    // Test at specific rate
    const testAtRate = async (rate, duration) => {
        const intervalMs = 1000 / rate
        const testResults = []
        const startTime = Date.now()
        let consecutiveFailures = 0

        while (Date.now() - startTime < duration) {
            const result = await testRequest(config.testUrl)
            testResults.push(result)
            
            if (!result.success) {
                consecutiveFailures++
                if (consecutiveFailures >= config.failureThreshold) {
                    log.warn('Consecutive failure threshold reached', { 
                        rate: `${rate} req/s`,
                        consecutiveFailures 
                    })
                    break
                }
            } else {
                consecutiveFailures = 0
            }
            
            await new Promise(resolve => setTimeout(resolve, intervalMs))
        }

        return testResults
    }

    // Run progressive or sustained test
    let lastSuccessfulRate = null
    
    if (config.sustainedRate) {
        log.info('Testing sustained rate', { rate: `${config.sustainedRate} req/s` })
        results.push(...await testAtRate(config.sustainedRate, config.testDuration))
        lastSuccessfulRate = config.sustainedRate
    } else {
        let currentRate = config.initialRate
        let foundLimit = false

        while (currentRate <= config.maxRate && !foundLimit) {
            log.info('Testing rate', { rate: `${currentRate} req/s` })
            
            const stepDuration = config.testDuration / 
                ((config.maxRate - config.initialRate) / config.rateIncrement + 1)
            
            const stepResults = await testAtRate(currentRate, stepDuration)
            results.push(...stepResults)
            
            const failures = stepResults.filter(r => !r.success).length
            const failureRate = failures / stepResults.length
            
            log.info('Rate test step complete', { 
                rate: `${currentRate} req/s`,
                requests: stepResults.length,
                failures,
                failureRate: `${(failureRate * 100).toFixed(1)}%`
            })
            
            // Check if this rate is acceptable (< 10% failure rate overall)
            if (failureRate > 0.1) {
                foundLimit = true
                log.success('Rate limit threshold exceeded', { 
                    rate: `${currentRate} req/s`,
                    failureRate: `${(failureRate * 100).toFixed(1)}%`
                })
                // Don't update lastSuccessfulRate
            } else {
                // This rate is acceptable
                lastSuccessfulRate = currentRate
                log.debug('Rate accepted', { 
                    rate: `${currentRate} req/s`,
                    failureRate: `${(failureRate * 100).toFixed(1)}%`
                })
                currentRate += config.rateIncrement
            }
        }
        
        // If we tested all rates without hitting limit
        if (!foundLimit && lastSuccessfulRate) {
            log.info('Reached max test rate without failures', { 
                maxTestedRate: `${lastSuccessfulRate} req/s` 
            })
        }
    }

    // Calculate stats
    const successfulRequests = results.filter(r => r.success).length
    const failedRequests = results.length - successfulRequests
    const totalDuration = results[results.length - 1]?.timestamp - results[0]?.timestamp || 0
    
    const successTimes = results.filter(r => r.success).map(r => r.duration)
    const avgResponseTime = successTimes.length > 0
        ? successTimes.reduce((a, b) => a + b, 0) / successTimes.length
        : null

    // Use last successful rate with 80% safety margin
    // If we never found a limit, we can be more aggressive (90% margin)
    let recommendedReqsPerSecond
    if (lastSuccessfulRate !== null) {
        const safetyMargin = (lastSuccessfulRate >= config.maxRate) ? 0.9 : 0.8
        recommendedReqsPerSecond = (lastSuccessfulRate * safetyMargin).toFixed(2)
    } else {
        // Fallback: calculate from actual observed rate
        const actualRate = successfulRequests / (totalDuration / 1000)
        recommendedReqsPerSecond = (actualRate * 0.8).toFixed(2)
    }

    const stats = {
        totalRequests: results.length,
        successfulRequests,
        failedRequests,
        totalDuration: (totalDuration / 1000).toFixed(2),
        lastSuccessfulRate,
        recommendedReqsPerSecond,
        safetyMargin: lastSuccessfulRate !== null ? 
            ((recommendedReqsPerSecond / lastSuccessfulRate) * 100).toFixed(0) + '%' : 'N/A',
        avgResponseTime: avgResponseTime ? avgResponseTime.toFixed(0) : null,
        minResponseTime: successTimes.length > 0 ? Math.min(...successTimes) : null,
        maxResponseTime: successTimes.length > 0 ? Math.max(...successTimes) : null,
        results
    }

    log.success('Rate limit test complete', {
        connector: driver.name,
        totalRequests: stats.totalRequests,
        successfulRequests: stats.successfulRequests,
        failedRequests: stats.failedRequests,
        lastSuccessfulRate: lastSuccessfulRate ? `${lastSuccessfulRate} req/s` : 'N/A',
        recommendedRate: `${stats.recommendedReqsPerSecond} req/s`,
        safetyMargin: stats.safetyMargin
    })

    return stats
}

// Helper to add rate limit testing to connectors
export function withRateLimitTesting(connector) {
    return {
        ...connector,
        
        testRateLimit: async (options = {}) => {
            return await RateLimitTester(connector, options)
        },
        
        testSustainedRate: async (rate, options = {}) => {
            return await RateLimitTester(connector, { 
                ...options, 
                sustainedRate: rate 
            })
        }
    }
}