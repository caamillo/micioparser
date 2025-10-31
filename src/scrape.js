import { Url, ProxyPool } from "./utils.js"
import log from "./log.js"
import { parseOutputOptions } from "./path.js"
import { DriverPool, Connectors } from "./driver.js"
import { RateLimiter, RateLimitTester } from "./ratelimit.js"
import { getSettings } from "./settings.js"
import WebSocket from 'ws'

const ws = new WebSocket('ws://localhost:8080')

ws.on('open', () => {
  log.attachStream(ws)
  log.info('Log stream attached to WS')
})

ws.on('close', () => {
  log.detachStream(ws)
  log.info('Log stream detached from WS')
})

ws.on('error', err => {
  log.warn('Log WS error', { message: err.message })
})

async function scrapeChapter(driver, chapterUrl, chapterIndex, pathParser, options = {}) {
    log.chapterStart(chapterIndex, chapterUrl.render())
    
    try {
        await driver.page.goto(chapterUrl.render(), { 
            waitUntil: 'networkidle',
            timeout: 30000 
        })
        
        await driver.page.waitForTimeout(1000)
        
        const pages = []
        let pageNum = 1
        
        const maxPages = typeof driver.getPageCount === 'function' 
            ? await driver.getPageCount() 
            : null
        
        const hasNavigation = typeof driver.getNextPage === 'function'
        
        if (maxPages !== null) {
            log.debug('Using defined page count', { maxPages, chapter: chapterIndex })
            
            for (pageNum = 1; pageNum <= maxPages; pageNum++) {
                try {
                    log.chapterPage(chapterIndex, pageNum, driver.page.url())
                    
                    const pathVars = {
                        chap: chapterIndex,
                        page: pageNum
                    }
                    
                    // Add optional variables if provided or if pattern needs them
                    if (options.title) pathVars.title = options.title
                    if (options.vol !== undefined) pathVars.vol = options.vol
                    // If pattern needs vol but not provided, default to 1
                    else if (pathParser.pattern.includes('$vol')) pathVars.vol = 1
                    
                    const outputPath = await pathParser.resolveAndEnsure(pathVars)

                    const img = await driver.getPage()
                    if (!img) throw new Error("Page image not found")
                    
                    await img.screenshot({ path: outputPath })
                    pages.push({ url: driver.page.url(), path: outputPath })
                    
                    if (pageNum < maxPages && hasNavigation) {
                        const navigated = await driver.getNextPage()
                        if (!navigated) {
                            log.warn('Navigation failed but more pages expected', { 
                                currentPage: pageNum, 
                                maxPages 
                            })
                            break
                        }
                    }
                } catch (error) {
                    log.error("Error scraping chapter page", error, { page: pageNum })
                    break
                }
            }
            
        } else if (hasNavigation) {
            log.debug('Using connector navigation method', { chapter: chapterIndex })
            
            while (true) {
                try {
                    log.chapterPage(chapterIndex, pageNum, driver.page.url())
                    
                    const pathVars = {
                        chap: chapterIndex,
                        page: pageNum
                    }
                    
                    // Add optional variables if provided or if pattern needs them
                    if (options.title) pathVars.title = options.title
                    if (options.vol !== undefined) pathVars.vol = options.vol
                    // If pattern needs vol but not provided, default to 0
                    else if (pathParser.pattern.includes('$vol')) pathVars.vol = 0
                    
                    const outputPath = await pathParser.resolveAndEnsure(pathVars)

                    const img = await driver.getPage()
                    if (!img) throw new Error("Page image not found")
                    
                    await img.screenshot({ path: outputPath })
                    pages.push({ url: driver.page.url(), path: outputPath })
                    
                    const hasNext = await driver.getNextPage()
                    if (!hasNext) {
                        log.debug('No more pages available', { totalPages: pageNum })
                        break
                    }
                    
                    pageNum++
                } catch (error) {
                    log.error("Error scraping chapter page", error, { page: pageNum })
                    break
                }
            }
            
        } else {
            log.debug('Using brute force', { chapter: chapterIndex })
            
            const firstImgSrc = await driver.getChapterLink()
            let pageUrl = Url.fromString(firstImgSrc)
            
            while (true) {
                try {
                    const res = await driver.page.goto(pageUrl.render())
                    log.chapterPage(chapterIndex, pageNum, pageUrl.render())
                    
                    if (!res.ok()) throw new Error(`HTTP ${res.status()}`)
                    
                    const pathVars = {
                        chap: chapterIndex,
                        page: pageNum
                    }
                    
                    // Add optional variables if provided or if pattern needs them
                    if (options.title) pathVars.title = options.title
                    if (options.vol !== undefined) pathVars.vol = options.vol
                    // If pattern needs vol but not provided, default to 0
                    else if (pathParser.pattern.includes('$vol')) pathVars.vol = 0
                    
                    const outputPath = await pathParser.resolveAndEnsure(pathVars)

                    const img = await driver.getPage()
                    if (!img) throw new Error("Page image not found")
                    
                    await img.screenshot({ path: outputPath })
                    pages.push({ url: pageUrl.render(), path: outputPath })
                    
                    pageUrl.incFile()
                    pageNum++
                } catch (error) {
                    log.debug("Reached end of chapter pages", { totalPages: pageNum - 1 })
                    break
                }
            }
        }
        
        log.chapterComplete(chapterIndex, pages.length)
        return { chapterIndex, chapterUrl: chapterUrl.render(), pages }
        
    } catch (error) {
        log.chapterError(chapterIndex, error, chapterUrl.render())
        return {
            chapterIndex,
            chapterUrl: chapterUrl.render(),
            pages: [],
            error: error.message
        }
    }
}

export async function defaultScrape(driver, options = {}) {
    log.info('Starting default scrape')
    
    const pathParser = parseOutputOptions(options)
    const volumes = await driver.getAllChapterLinks()

    log.debug('Retrieved volumes and chapters', { 
        volumes: volumes.length,
        totalChapters: volumes.reduce((sum, v) => sum + v.chapters.length, 0)
    })
    
    const out = []
    let chapterIndex = 1
    
    // Iterate through each volume
    for (const volume of volumes) {
        // Iterate through each chapter in the volume
        for (const chapterUrl of volume.chapters) {
            const opts = { ...options }
            
            // Pass the volume number if available
            if (volume.volume) {
                opts.vol = volume.volume
            }
            
            const res = await scrapeChapter(driver, chapterUrl, chapterIndex, pathParser, opts)
            out.push(res)
            chapterIndex++
        }
    }
    
    log.scrapeComplete({ chapters: out.length })
    return out
}

export async function bruteScrape(driver, options = {}) {
    const { 
        target, 
        maxAttempts = 10, 
        onProgress = null,
        stopOnError = false 
    } = options
    
    // Extract URL from target
    const targetUrl = typeof target === 'object' 
        ? (target.link || target.url)
        : target
    
    if (!targetUrl) {
        const error = new Error('target is required for bruteforce')
        log.error('Bruteforce scrape configuration error', error)
        throw error
    }
    
    const pathParser = parseOutputOptions(options)
    log.info('Starting bruteforce scrape', { 
        target: targetUrl, 
        maxAttempts, 
        outputPattern: pathParser.pattern 
    })
    
    let stats = { pagesScraped: 0, pagesFailed: 0, errors: [] }
    let currentVol = 1
    let currentChap = 1
    
    try {
        const firstCh = Url.fromString(targetUrl)
        log.debug('Navigating to start URL', { url: firstCh.render() })
        
        const navRes = await driver.page.goto(firstCh.render())
        if (!navRes.ok()) {
            const error = new Error(`Failed to navigate to target: ${firstCh.render()}`)
            log.navigationError(firstCh.render(), error)
            throw error
        }
        
        const imgSrc = await driver.getChapterLink()
        if (!imgSrc) {
            const error = new Error("Page image has no src attribute")
            log.error('Image source not found', error)
            throw error
        }
        
        log.debug('Found initial image source', { imgSrc })
        
        let page = Url.fromString(imgSrc)
        page.editRoute(2, { type: "counter" })
        page.editRoute(3, { type: "counter" })

        const resetParams = () => ({
            tryVolumes: true,
            tryChapters: true,
            toInc: new Array(2).fill(maxAttempts),
            firstIter: true
        })
        
        let state = resetParams()
        const resetState = () => { state = resetParams() }

        while (page) {
            const url = page.render()
            
            try {
                const res = await driver.page.goto(url)
                if (!res.ok()) throw new Error(`HTTP ${res.status()}`)
                
                resetState()
                
                const pathVars = {
                    vol: currentVol,
                    chap: currentChap,
                    page: stats.pagesScraped + 1
                }
                
                // Only add title if provided
                if (options.title) pathVars.title = options.title
                
                const outputPath = await pathParser.resolveAndEnsure(pathVars)
                
                await driver.page.screenshot({ path: outputPath, fullPage: true })
                
                stats.pagesScraped++
                log.scrapeSuccess(url, { 
                    pageNumber: stats.pagesScraped,
                    volume: currentVol,
                    chapter: currentChap,
                    path: outputPath
                })
                
                if (onProgress) onProgress({ 
                    type: 'success', 
                    url, 
                    stats,
                    path: outputPath 
                })
                page.incFile()
                
            } catch (err) {
                stats.pagesFailed++
                log.scrapeAttempt(url, err.message, {
                    pagesFailed: stats.pagesFailed,
                    pagesScraped: stats.pagesScraped,
                    volume: currentVol,
                    chapter: currentChap
                })
                
                const [, , volume, chapter] = page.routes
                
                if (!volume || !chapter) {
                    const e = new Error("Invalid route structure, missing volume or chapter")
                    log.routeError(e.message, page.render())
                    stats.errors.push(e)
                    if (stopOnError) throw e
                    break
                }
                
                let modifying
                
                if (state.tryChapters) {
                    modifying = chapter
                    if (state.toInc[0] > 0) {
                        chapter.inc()
                        currentChap++
                        state.toInc[0]--
                        log.debug('Incrementing chapter', { 
                            chapter: currentChap,
                            newValue: chapter.value,
                            attemptsLeft: state.toInc[0] 
                        })
                    } else {
                        state.tryChapters = false
                        state.toInc = new Array(2).fill(maxAttempts)
                        state.firstIter = true
                        modifying = volume
                        chapter.inc(-maxAttempts)
                        currentChap -= maxAttempts
                        log.debug('Switching to volume increment', { 
                            volume: currentVol,
                            volumeValue: volume.value 
                        })
                    }
                } else if (state.tryVolumes) {
                    modifying = volume
                    if (state.toInc[0] > 0 || state.toInc[1] > 0) {
                        if (state.toInc[0] === 0) {
                            volume.inc()
                            currentVol++
                            chapter.inc(-maxAttempts)
                            currentChap -= maxAttempts
                            state.toInc[1]--
                            state.toInc[0] = maxAttempts
                            log.debug('Incrementing volume', { 
                                volume: currentVol,
                                newValue: volume.value,
                                volumeAttemptsLeft: state.toInc[1] 
                            })
                        }
                        chapter.inc()
                        currentChap++
                        state.toInc[0]--
                    } else {
                        state.tryVolumes = false
                        log.debug('Exhausted all attempts')
                    }
                } else {
                    log.info('Bruteforce scrape complete - no more attempts')
                    break
                }
                
                if (state.firstIter && modifying) {
                    page.resetFile()
                    const route = modifying.value
                    const firstDash = route.indexOf('-')
                    const lastDash = route.lastIndexOf('-')
                    
                    if (firstDash === -1 || lastDash === -1 || firstDash === lastDash) {
                        const error = new Error(`Invalid route format: ${route}`)
                        log.routeError(error.message, route)
                        stats.errors.push(error)
                        if (stopOnError) throw error
                        continue
                    }
                    
                    let idx = route.slice(firstDash + 1, lastDash)
                    const parsed = parseInt(idx)
                    
                    if (isNaN(parsed)) {
                        const error = new Error(`Cannot parse index from route: ${route}`)
                        log.routeError(error.message, route)
                        stats.errors.push(error)
                        if (stopOnError) throw error
                        continue
                    }
                    
                    idx = String(parsed + 1).padStart(2, '0')
                    modifying.edit({ 
                        value: route.slice(0, firstDash + 1) + idx + route.slice(lastDash) 
                    })
                    state.firstIter = false
                    
                    log.debug('Updated route format', { 
                        oldRoute: route,
                        newRoute: modifying.value 
                    })
                }
                
                if (onProgress) onProgress({ 
                    type: 'attempt', 
                    url, 
                    error: err.message, 
                    stats 
                })
            }
        }
        
        log.scrapeComplete(stats)
        return stats
        
    } catch (err) {
        stats.errors.push(err)
        log.error('Bruteforce scrape failed', err, stats)
        throw err
    }
}

function makeItemRunner(coreFn) {
    return async (driver, item, chapterIndex, options = {}) => {
        log.debug('Running item', { 
            method: coreFn.name,
            chapterIndex,
            url: item.render ? item.render() : (item.link || item.url)
        })
        
        if (coreFn === defaultScrape) {
            const pathParser = parseOutputOptions(options)
            
            // Handle different item types
            let chapterUrl = item
            let volumeOpts = { ...options }
            
            // If it's a volume chapter object, extract the URL and volume info
            if (item.url) {
                chapterUrl = item.url
            }
            if (item.volume && !volumeOpts.vol) {
                volumeOpts.vol = item.volume
            }
            
            return scrapeChapter(driver, chapterUrl, chapterIndex, pathParser, volumeOpts)
        }
        
        // For bruteScrape, convert item to target
        const targetUrl = item.render ? item.render() : (item.link || item.url)
        return coreFn(driver, { ...options, target: targetUrl })
    }
}

async function normalizeResult(coreFn, rawResult, startAt, mode) {
    const method = coreFn.name
    
    if (Array.isArray(rawResult)) {
        return rawResult.map(r => ({
            method,
            mode,
            chapterUrl: r.chapterUrl,
            result: r,
            error: r.error,
            delta_t: Date.now() - startAt
        }))
    }
    
    return [{
        method,
        mode,
        result: rawResult
    }]
}

export async function processSingle(coreFn, exec, opt = {}) {
    const options = { ...exec.opt, ...opt }

    log.info('Starting single processing', { method: coreFn.name })
    
    // Handle target parameter (can be URL string or book object)
    let targetUrl = options.target
    
    if (!targetUrl) {
        log.error('Target is required for processing', new Error('Missing target parameter'))
        throw new Error('Target is required. Please provide { target: bookObject } or { target: "url" }')
    }
    
    if (typeof options.target === 'object') {
        // Extract title if pattern needs it
        if (!options.title && exec.opt.outputPath?.includes('$title') && options.target.title) {
            options.title = options.target.title
            log.debug('Extracted title from target object', { title: options.title })
        }
        targetUrl = options.target.link || options.target.url
        
        if (!targetUrl) {
            log.error('Target object missing link/url property', new Error('Invalid target object'))
            throw new Error('Target object must have either "link" or "url" property')
        }
    }
    
    log.debug('Processing with target', { targetUrl, title: options.title })
    
    let results
    await exec.lock(async (driver) => {
        await driver.go(targetUrl)
        const raw = await coreFn(driver, options)
        results = await normalizeResult(coreFn, raw, exec.startAt, 'single')
        
        log.success('Single processing complete', { method: coreFn.name })
    })
    return results
}

export async function processParallel(coreFn, exec, opt = {}) {
    const options = { ...exec.opt, ...opt }
    const drivers = exec.drivers
    const { concurrency } = options

    log.info('Starting parallel processing', { 
        method: coreFn.name,
        driverCount: drivers.length(),
        ...options
    })

    // Handle target parameter (can be URL string or book object)
    let targetUrl = options.target
    if (typeof options.target === 'object') {
        // Extract title if pattern needs it
        if (!options.title && exec.opt.outputPath?.includes('$title') && options.target.title) {
            options.title = options.target.title
            log.debug('Extracted title from target object', { title: options.title })
        }
        targetUrl = options.target.link || options.target.url || options.target
    }

    let volumes

    await exec.lock(async (driver) => {
        await driver.go(targetUrl)
        volumes = await driver.getAllChapterLinks()
    })

    // Flatten all chapters from all volumes
    let chapLinks = []
    for (const volume of volumes) {
        for (const chapterUrl of volume.chapters) {
            chapLinks.push({
                url: chapterUrl,
                volume: volume.volume
            })
        }
    }
    
    log.debug('Retrieved chapters for parallel processing', { 
        totalChapters: chapLinks.length,
        chunks: Math.ceil(chapLinks.length / concurrency) 
    })
    
    const chunks = []
    for (let i = 0; i < chapLinks.length; i += concurrency) {
        chunks.push(chapLinks.slice(i, i + concurrency))
    }
    
    const runner = makeItemRunner(coreFn)
    const allResults = []
    
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex]
        log.debug('Processing chunk', { 
            chunkIndex: chunkIndex + 1,
            totalChunks: chunks.length,
            chunkSize: chunk.length 
        })
        
        const promises = chunk.map(async (chapLink, idx) => {
            const chapterIndex = chunkIndex * concurrency + idx + 1
            let result

            try {
                await exec.lock(async (driver) => {
                    result = await runner(driver, chapLink, chapterIndex, options)
                })
            } catch (err) {
                log.error('Parallel item failed', err, { 
                    chapterIndex,
                    url: chapLink.render() 
                })
                
                return [{
                    method: coreFn.name,
                    mode: 'parallel',
                    result: null,
                    error: err.message
                }]
            }

            return normalizeResult(coreFn, result, exec.startAt, 'parallel')
        })
        
        const chunkResults = await Promise.all(promises)
        chunkResults.flat().forEach(r => allResults.push(r))
    }
    
    log.success('Parallel processing complete', { 
        method: coreFn.name,
        totalResults: allResults.length 
    })
    return allResults
}

export async function processBatch(coreFn, exec, opt = {}) {
    const options = { ...exec.opt, ...opt }
    const { batchSize = 10 } = options

    log.info('Starting batch processing', { 
        method: coreFn.name,
        batchSize 
    })

    // Handle target parameter (can be URL string or book object)
    let targetUrl = options.target
    if (typeof options.target === 'object') {
        // Extract title if pattern needs it
        if (!options.title && exec.opt.outputPath?.includes('$title') && options.target.title) {
            options.title = options.target.title
            log.debug('Extracted title from target object', { title: options.title })
        }
        targetUrl = options.target.link || options.target.url || options.target
    }

    let volumes

    await exec.lock(async (driver) => {
        await driver.go(targetUrl)
        volumes = await driver.getAllChapterLinks()
    })

    // Flatten all chapters from all volumes
    const chapLinks = []
    for (const volume of volumes) {
        for (const chapterUrl of volume.chapters) {
            chapLinks.push({
                url: chapterUrl,
                volume: volume.volume
            })
        }
    }
    
    log.debug('Retrieved chapters for batch processing', { 
        totalChapters: chapLinks.length,
        batches: Math.ceil(chapLinks.length / batchSize) 
    })
    
    const allResults = []
    
    for (let i = 0; i < chapLinks.length; i += batchSize) {
        const batch = chapLinks.slice(i, Math.min(i + batchSize, chapLinks.length))
        log.debug('Processing batch', { 
            batchStart: i + 1,
            batchEnd: i + batch.length,
            batchSize: batch.length 
        })
        
        for (let j = 0; j < batch.length; j++) {
            const chapLink = batch[j]
            const chapterIndex = i + j + 1
            
            try {
                let raw
                await exec.lock(async (driver) => {
                    raw = await makeItemRunner(coreFn)(driver, chapLink, chapterIndex, options)
                })
                const norm = await normalizeResult(coreFn, raw, exec.startAt, 'batch')
                norm.forEach(n => allResults.push(n))
            } catch (err) {
                log.error('Batch item failed', err, { 
                    chapterIndex,
                    url: chapLink.render() 
                })
                allResults.push({
                    method: coreFn.name || 'unknown',
                    mode: 'batch',
                    result: null,
                    error: err.message
                })
            }
        }
    }
    
    log.success('Batch processing complete', { 
        method: coreFn.name,
        totalResults: allResults.length 
    })
    return allResults
}

const Methods = {
    default: defaultScrape,
    bruteforce: bruteScrape
}

const Modes = {
    single: processSingle,
    parallel: processParallel,
    batch: processBatch
}

export class ScrapingExecution {
    constructor(opt={}) {
        opt = {
            proxy: new ProxyPool(),
            context_usage: 'multi-context',
            outputPath: 'downloads/$title/$vol/$chap/$page.png',
            concurrency: 3,
            rateLimit: 'auto',
            testIfMissing: true, // Auto rate-limit test if config not found
            maxConfigAge: 30, // Days before config is considered stale
            global_search_keys: [
                'link', 'banner', 'title',
                'type', 'author', 'artist',
                'genres', 'short_plot'
            ],
            ...opt
        }

        this.drivers = new DriverPool(opt)
        this.opt = opt
        this.startAt = null
        this.settings = null
        
        // Track connector-specific driver indices for sequential searches
        this.connectorIndices = {}
        
        // Initialize rate limiter
        if (opt.rateLimit === 'auto') {
            this.rateLimiter = RateLimiter({ mode: 'auto' })
            log.info('Rate limiter initialized in auto mode')
        } else {
            this.rateLimiter = RateLimiter({ 
                mode: 'manual',
                reqsPerSecond: opt.rateLimit
            })
            log.info('Rate limiter initialized in manual mode', { 
                reqsPerSecond: opt.rateLimit 
            })
        }
        
        this._loadSettings()
    }
    
    async _loadSettings() {
        try {
            this.settings = await getSettings()
            log.info('Settings loaded for execution')
        } catch (error) {
            log.error('Failed to load settings', error)
        }
    }
    
    async _ensureSettings() {
        if (!this.settings) {
            await this._loadSettings()
        }
    }
    
    /**
     * Configure rate limiter from settings or test
     * @private
     * @param {string} connectorName - Connector to configure for
     * @param {boolean} skipTest - Skip testing if config missing (default: false)
     */
    async _configureRateLimiter(connectorName, skipTest = false) {
        await this._ensureSettings()
        
        // If using manual rate limit, skip
        if (this.opt.rateLimit !== 'auto') {
            log.debug('Manual rate limit set, skipping auto-configuration')
            return
        }
        
        // If already configured for this connector, skip
        const currentConfig = this.rateLimiter.getConfig()
        if (currentConfig.isConfigured && currentConfig._lastConnector === connectorName) {
            log.debug('Rate limiter already configured for connector', { connector: connectorName })
            return
        }
        
        // Check if configuration is saved
        if (this.settings && this.settings.hasDriverConfig(connectorName)) {
            const config = this.settings.getDriverConfig(connectorName)
            
            // Check if config is stale
            if (this.settings.isConfigStale(connectorName, this.opt.maxConfigAge)) {
                log.warn('Driver configuration is stale, will re-test', {
                    connector: connectorName,
                    maxAge: `${this.opt.maxConfigAge} days`
                })
                
                if (this.opt.testIfMissing && !skipTest) {
                    await this._testAndSaveRateLimit(connectorName)
                }
            } else {
                // Use saved configuration
                this.rateLimiter.setRate(config.reqsPerSecond)
                this.rateLimiter._lastConnector = connectorName
                log.success('Using saved rate limit configuration', {
                    connector: connectorName,
                    reqsPerSecond: config.reqsPerSecond,
                    testedAt: config.testedAt
                })
            }
        } else {
            // No configuration found
            log.info('No configuration found for connector', { connector: connectorName })
            
            if (this.opt.testIfMissing && !skipTest) {
                await this._testAndSaveRateLimit(connectorName)
            }
        }
    }
    
    /**
     * Test rate limit and save to settings
     * @private
     * @param {string} connectorName - Connector to test
     */
    async _testAndSaveRateLimit(connectorName) {
        log.info('Testing rate limit for connector', { connector: connectorName })
        
        const driver = this._getConnectorDriver(connectorName)
        if (!driver) {
            throw new Error(`No driver available for connector: ${connectorName}`)
        }
        
        // Disable rate limiting during test
        const originalMode = this.rateLimiter.getConfig().mode
        this.rateLimiter.setRate(Infinity)
        
        let stats
        await driver.exec(async (driverApi) => {
            stats = await RateLimitTester(driverApi, {})
        })
        
        // Restore and configure rate limiter
        if (originalMode === 'auto') {
            this.rateLimiter.configureFromStats(stats)
            this.rateLimiter._lastConnector = connectorName
        }
        
        // Save to settings if enabled
        if (this.settings) {
            await this.settings.setDriverConfig(connectorName, stats)
        }
    }
    
    /**
     * Initialize global search by creating drivers for all connectors
     * @private
     * @param {string} browser - Browser to use (default: 'chromium')
     */
    async _initGlobalSearch(browser='chromium') {
        log.info('Initializing global search', { 
            connectors: Object.keys(Connectors),
            browser 
        })
        
        // Build drivers for all connectors
        const driverConfigs = Object.keys(Connectors).map(cnt => [cnt, browser])
        
        // Create new pool or clear existing
        const pool = new DriverPool(this.opt)
        await Promise.all(
            driverConfigs.map(async ([connector, browser]) => 
                await pool.addDriver(connector, browser, this.opt)
            )
        )
        this.drivers = pool
        
        // Initialize connector indices
        this.connectorIndices = {}
        for (const connectorId of Object.keys(Connectors)) {
            this.connectorIndices[connectorId] = 0
        }
        
        log.success('Global search initialized', { 
            connectors: Object.keys(Connectors),
            driversCount: this.drivers.length(),
            browser 
        })
    }

    /**
     * Get the next available driver for a specific connector
     * @param {string} connectorId - The connector to get a driver for
     * @returns {Driver|null} The next driver for this connector
     */
    _getConnectorDriver(connectorId) {
        if (!this.drivers.isValid()) return null
        
        // Find all drivers with this connector
        const matchingDrivers = this.drivers.pool.filter(
            d => d.connector_id === connectorId
        )
        
        if (!matchingDrivers.length) {
            log.warn('No drivers found for connector', { connectorId })
            return null
        }
        
        // Get current index for this connector (initialize if needed)
        if (!(connectorId in this.connectorIndices)) {
            this.connectorIndices[connectorId] = 0
        }
        
        // Get driver and rotate index
        const driver = matchingDrivers[this.connectorIndices[connectorId]]
        this.connectorIndices[connectorId] = 
            (this.connectorIndices[connectorId] + 1) % matchingDrivers.length
        
        return driver
    }

    /**
     * Execute a function with a specific connector's driver
     * @param {string} connectorId - The connector to use
     * @param {Function} fn - The function to execute with the driver
     */
    async lockConnector(connectorId, fn) {
        if (!this.isValid()) {
            throw new Error('ScrapingExecution is not valid')
        }
        
        const driver = this._getConnectorDriver(connectorId)
        if (!driver) {
            throw new Error(`No driver available for connector: ${connectorId}`)
        }
        
        // Configure rate limiter for this connector if needed
        await this._configureRateLimiter(connectorId)
        
        await this.rateLimiter.throttle()
        
        const startTime = Date.now()
        const result = await driver.exec(fn)
        const duration = Date.now() - startTime
        
        log.debug('Connector request completed', { 
            connector: connectorId,
            durationMs: duration,
            rateLimitConfig: this.rateLimiter.getConfig()
        })
        
        return result
    }

    /**
     * Search for a title across manga sources
     * @param {string} title - The title to search for
     * @param {string|null} connector - could be:
     *   - null: Progressive search (rotates through all connectors)
     *   - 'connector_name': Search only on specific connector
     *   - '*': Search on all connectors simultaneously
     * @param {Object} options - Search options
     * @param {boolean} options.sequential - If true, searches one at a time (default: true)
     * @returns {Promise<Object|Array>} Search results
     */
    async search(title, connector=null, options={}) {
        const { sequential = true, browser = 'chromium' } = options
        
        // 1: Search on all connectors
        if (connector === '*') {
            // Check if we need to initialize global search
            const needsInit = !this.drivers.isValid() || 
                Object.keys(Connectors).some(connectorId => {
                    return !this.drivers.pool.some(d => d.connector_id === connectorId)
                })
            
            if (needsInit) {
                log.info('Global search not initialized, auto-initializing...', { browser })
                await this._initGlobalSearch(browser)
            }
            
            if (!this.isValid()) {
                throw new Error('Failed to initialize global search')
            }
            
            log.info('Starting global search on all connectors', { 
                title,
                mode: sequential ? 'sequential' : 'parallel'
            })
            
            const availableConnectors = Object.keys(Connectors).filter(connectorId => {
                const hasDriver = this.drivers.pool.some(
                    d => d.connector_id === connectorId
                )
                
                if (!hasDriver) {
                    log.warn('Skipping connector (no driver available)', { 
                        connector: connectorId 
                    })
                }
                
                return hasDriver
            })
            
            let results = []
            
            if (sequential) {
                // Sequential execution - one at a time
                for (const connectorId of availableConnectors) {
                    try {
                        const connectorResults = await this.lockConnector(
                            connectorId,
                            async (driver) => await driver.search(title)
                        )
                        
                        results.push({
                            connector: connectorId,
                            success: true,
                            results: connectorResults,
                            count: connectorResults?.length || 0
                        })
                        
                        log.success('Connector search completed', {
                            connector: connectorId,
                            resultsCount: connectorResults?.length || 0
                        })
                    } catch (error) {
                        log.error('Connector search failed', error, { 
                            connector: connectorId 
                        })
                        
                        results.push({
                            connector: connectorId,
                            success: false,
                            error: error.message,
                            results: []
                        })
                    }
                }
            } else {
                // Parallel execution - all at once
                const searchPromises = availableConnectors.map(async (connectorId) => {
                    try {
                        const connectorResults = await this.lockConnector(
                            connectorId,
                            async (driver) => await driver.search(title)
                        )
                        
                        log.success('Connector search completed', {
                            connector: connectorId,
                            resultsCount: connectorResults?.length || 0
                        })
                        
                        return {
                            connector: connectorId,
                            success: true,
                            results: connectorResults,
                            count: connectorResults?.length || 0
                        }
                    } catch (error) {
                        log.error('Connector search failed', error, { 
                            connector: connectorId 
                        })
                        
                        return {
                            connector: connectorId,
                            success: false,
                            error: error.message,
                            results: []
                        }
                    }
                })
                
                results = await Promise.all(searchPromises)
            }
            
            const totalResults = results.reduce(
                (sum, r) => sum + (r.count || 0), 
                0
            )
            
            log.success('Global search completed', {
                title,
                mode: sequential ? 'sequential' : 'parallel',
                connectors: results.length,
                totalResults
            })
            
            return results
        }
        
        // 2: Search on specific connector
        if (connector && typeof connector === 'string') {
            if (!(connector in Connectors)) {
                throw new Error(`Unknown connector: ${connector}`)
            }
            
            // Check if we need to initialize this specific connector
            const hasConnectorDriver = this.drivers.pool.some(
                d => d.connector_id === connector
            )
            
            if (!hasConnectorDriver) {
                log.info('Connector not initialized, auto-initializing...', { 
                    connector,
                    browser 
                })
                
                // Initialize only this connector
                const pool = new DriverPool(this.opt)
                await pool.addDriver(connector, browser, this.opt)
                this.drivers = pool
                
                // Initialize connector index
                if (!this.connectorIndices[connector]) {
                    this.connectorIndices[connector] = 0
                }
                
                log.success('Connector initialized', { connector })
            }
            
            if (!this.isValid()) {
                throw new Error('Failed to initialize connector')
            }
            
            log.info('Starting targeted search', { 
                title, 
                connector 
            })
            
            const results = await this.lockConnector(
                connector,
                async (driver) => await driver.search(title)
            )
            
            log.success('Targeted search completed', {
                connector,
                resultsCount: results?.length || 0
            })
            
            return {
                connector,
                success: true,
                results,
                count: results?.length || 0
            }
        }
        
        // 3: Progressive search (round-robin through available connectors)
        if (!this.isValid()) {
            throw new Error('ScrapingExecution is not valid. Initialize drivers first.')
        }
        
        log.info('Starting progressive search', { title })
        
        // Use standard lock which rotates through all drivers
        const results = await this.lock(
            async (driver) => await driver.search(title)
        )
        
        // Get the connector that was used (from the driver that was selected)
        const usedDriver = this.drivers.pool[
            (this.drivers.idx - 1 + this.drivers.pool.length) % this.drivers.pool.length
        ]
        
        log.success('Progressive search completed', {
            connector: usedDriver?.connector_id,
            resultsCount: results?.length || 0
        })
        
        return {
            connector: usedDriver?.connector_id,
            success: true,
            results,
            count: results?.length || 0
        }
    }

    async lock(fn) {
        if (!this.isValid()) return

        await this.rateLimiter.throttle()
        
        const startTime = Date.now()
        const result = await this.drivers.exec(fn)
        const duration = Date.now() - startTime
        
        log.debug('Request completed', { 
            durationMs: duration,
            rateLimitConfig: this.rateLimiter.getConfig()
        })
        
        return result
    }

    isValid() {
        return this.drivers.isValid()
    }

    async testRateLimit(options = {}) {
        log.info('Testing rate limit for execution')
        
        let stats
        await this.lock(async (driver) => {
            stats = await RateLimitTester(driver, options)
        })
        
        if (this.rateLimiter.getConfig().mode === 'auto') {
            this.rateLimiter.configureFromStats(stats)
        }
        
        return stats
    }

    async process(method="default", mode="single", opt={}) {
        try {
            method = Methods?.[method]
            if (!method) throw new Error('Invalid method.')
            
            mode = Modes?.[mode]
            if (!mode) throw new Error('Invalid mode.')

            const limiterConfig = this.rateLimiter.getConfig()
            if (limiterConfig.mode === 'auto' && !limiterConfig.isConfigured) {
                log.info('Running test packages to driver endpoint to get best perfomance...')
                await this.testRateLimit()
            }

            this.startAt = Date.now()
            const results = await mode?.(method, this, opt)
            
            const totalTime = Date.now() - this.startAt
            log.success('Processing complete', {
                method: method.name,
                mode: mode.name,
                totalTimeMs: totalTime,
                rateLimitConfig: this.rateLimiter.getConfig()
            })
            
            return results
        } catch (err) {
            log.error('Error processing', err)
            throw err
        }
    }

    async withDrivers(drivers) {
        const pool = new DriverPool()
        await Promise.all(drivers.map(async driver => await pool.addDriver(...driver, this.opt)))
        this.drivers = pool
        return this
    }

    static withOptions(opt={}) {
        const self = this.copy()
        self.opt = { ...self.opt, ...opt }
        
        // Ratelimit rebuild
        if ('rateLimit' in opt) {
            if (opt.rateLimit === 'auto') {
                self.rateLimiter = RateLimiter({ mode: 'auto' })
            } else {
                self.rateLimiter = RateLimiter({ 
                    mode: 'manual',
                    reqsPerSecond: opt.rateLimit
                })
            }
        }
        
        return self
    }

    addOption(opt={}) {
        this.opt = { ...this.opt, ...opt }
        
        // Ratelimit rebuild
        if ('rateLimit' in opt) {
            if (opt.rateLimit === 'auto') {
                this.rateLimiter = RateLimiter({ mode: 'auto' })
                log.info('Rate limiter switched to auto mode')
            } else {
                this.rateLimiter.setRate(opt.rateLimit)
            }
        }
    }

    setRateLimit(reqsPerSecond) {
        this.opt.rateLimit = reqsPerSecond
        this.rateLimiter.setRate(reqsPerSecond)
    }

    getRateLimitConfig() {
        return this.rateLimiter.getConfig()
    }

    resetRateLimitToAuto() {
        this.opt.rateLimit = 'auto'
        this.rateLimiter.resetToAuto()
    }
}