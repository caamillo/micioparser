import log from "./log.js"
import { RateLimiter } from "./ratelimit.js"

/**
 * Context modes
 */
export const ContextMode = {
    SINGLE: 'single',   // Reuse same browser context (no proxy rotation)
    MULTI: 'multi'      // Create new context for each navigation (proxy rotation)
}

/**
 * Navigation Lock - centralizes all page navigation concerns:
 * - Rate limiting per connector
 * - Context switching (single/multi)
 * - Proxy rotation
 * - Per-connector locking
 */
export class NavigationLock {
    constructor(options = {}) {
        this.contextMode = options.contextMode || ContextMode.SINGLE
        this.proxyPool = options.proxyPool || null
        this.rateLimiters = new Map() // connector -> RateLimiter
        this.locks = new Map() // connector -> { locked, queue }
        
        // Auto-detect context mode based on proxy availability
        if (this.contextMode === ContextMode.SINGLE && this.proxyPool?.pool?.length > 0) {
            this.contextMode = ContextMode.MULTI
            log.info('Auto-detected multi-context mode (proxies available)')
        }

        log.info('Navigation lock initialized', {
            contextMode: this.contextMode,
            proxyCount: this.proxyPool?.pool?.length || 0
        })
    }

    /**
     * Get or create rate limiter for connector
     */
    _getRateLimiter(connector) {
        if (!this.rateLimiters.has(connector)) {
            this.rateLimiters.set(connector, RateLimiter({ mode: 'auto' }))
        }
        return this.rateLimiters.get(connector)
    }

    /**
     * Get or create lock state for connector
     */
    _getLockState(connector) {
        if (!this.locks.has(connector)) {
            this.locks.set(connector, {
                locked: false,
                queue: []
            })
        }
        return this.locks.get(connector)
    }

    /**
     * Acquire navigation lock for connector
     * This is called before every page navigation
     */
    async acquire(connector) {
        const lockState = this._getLockState(connector)

        // Wait for lock to be available
        while (lockState.locked) {
            await new Promise(resolve => {
                lockState.queue.push(resolve)
            })
        }

        // Acquire lock
        lockState.locked = true

        log.debug('Navigation lock acquired', { 
            connector,
            contextMode: this.contextMode,
            queueLength: lockState.queue.length
        })

        // Apply rate limiting
        const rateLimiter = this._getRateLimiter(connector)
        await rateLimiter.throttle()
    }

    /**
     * Release navigation lock for connector
     */
    release(connector) {
        const lockState = this._getLockState(connector)

        if (!lockState.locked) {
            log.warn('Attempting to release unlocked navigation lock', { connector })
            return
        }

        // Release lock
        lockState.locked = false

        // Wake up next waiter
        if (lockState.queue.length > 0) {
            const resolve = lockState.queue.shift()
            resolve()
        }

        log.debug('Navigation lock released', { 
            connector,
            queueLength: lockState.queue.length
        })
    }

    /**
     * Configure rate limiter for connector
     */
    configureRateLimit(connector, stats) {
        const rateLimiter = this._getRateLimiter(connector)
        rateLimiter.configureFromStats(stats)
        
        log.success('Rate limit configured', {
            connector,
            reqsPerSecond: stats.recommendedReqsPerSecond
        })
    }

    /**
     * Set manual rate limit for connector
     */
    setRateLimit(connector, reqsPerSecond) {
        const rateLimiter = this._getRateLimiter(connector)
        rateLimiter.setRate(reqsPerSecond)
    }

    /**
     * Get rate limit config for connector
     */
    getRateLimitConfig(connector) {
        const rateLimiter = this._getRateLimiter(connector)
        return rateLimiter.getConfig()
    }

    /**
     * Get all rate limit configs
     */
    getAllRateLimitConfigs() {
        const configs = {}
        this.rateLimiters.forEach((limiter, connector) => {
            configs[connector] = limiter.getConfig()
        })
        return configs
    }

    /**
     * Check if connector is locked
     */
    isLocked(connector) {
        const lockState = this._getLockState(connector)
        return lockState.locked
    }

    /**
     * Get status of all locks
     */
    getStatus() {
        const locks = {}
        this.locks.forEach((state, connector) => {
            locks[connector] = {
                locked: state.locked,
                queueLength: state.queue.length
            }
        })

        return {
            contextMode: this.contextMode,
            proxyCount: this.proxyPool?.pool?.length || 0,
            locks,
            rateLimiters: this.getAllRateLimitConfigs()
        }
    }

    /**
     * Set context mode
     */
    setContextMode(mode) {
        if (!Object.values(ContextMode).includes(mode)) {
            throw new Error(`Invalid context mode: ${mode}`)
        }

        this.contextMode = mode
        log.info('Context mode changed', { contextMode: mode })
    }

    /**
     * Get next proxy (for multi-context mode)
     */
    getNextProxy() {
        if (!this.proxyPool) return null
        return this.proxyPool.getProxy()
    }
}