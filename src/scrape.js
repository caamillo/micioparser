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
            ? await driver.getPageCount(driver.page) 
            : null
        
        while (true) {
            log.pageStart(pageNum, maxPages)
            
            // 1. Get the image element handle
            const imageHandle = await driver.getPageImage()
            
            // 2. Extract image data (src or blob)
            const src = await imageHandle.getAttribute('src')
            const data = await driver.page.evaluate(
                (el) => el.currentSrc || el.src, imageHandle
            )

            pages.push({ pageNum, data: src })

            // 3. Increment URL or navigate to next page
            let navigated = false
            if (chapterUrl.hasArg('page')) {
                // Try URL incrementation first
                chapterUrl.incrArg('page')
                log.debug('Trying URL incrementation', { url: chapterUrl.render() })
                await driver.page.goto(chapterUrl.render(), { 
                    waitUntil: 'networkidle',
                    timeout: 20000
                })
                navigated = true
            } else if (typeof driver.getNextPage === 'function') {
                // Fallback to UI navigation
                log.debug('Trying UI navigation')
                navigated = await driver.getNextPage()
            }
            
            if (!navigated) {
                log.pageEnd(pageNum, true)
                break // End of chapter
            }

            pageNum++

            // Stop if maxPages is known and reached
            if (maxPages && pageNum > maxPages) {
                log.debug('Max pages reached', { pageNum, maxPages })
                break
            }
        }
        
        log.chapterEnd(chapterIndex, chapterUrl.render(), true)
        return pages

    } catch (error) {
        log.error('Chapter scraping failed', { error: error.message, url: chapterUrl.render() })
        log.chapterEnd(chapterIndex, chapterUrl.render(), false)
        return { error: error.message }
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
    static withOptions(opt={}) {
        const self = new ScrapingExecution()
        self.opt = { ...self.opt, ...opt }
        
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

    constructor(opt={}) {
        this.connectors = Connectors 
        this.drivers = null 
        this.proxies = new ProxyPool() 
        this.opt = { 
            context_usage: 'single-context', 
            concurrency: 1, 
            onItem: () => {},
            ...opt 
        }

        this.rateLimiter = RateLimiter(
            opt.rateLimit === 'auto' 
                ? { mode: 'auto' } 
                : { mode: 'manual', reqsPerSecond: opt.rateLimit || Infinity }
        )
        
        this.driverLocks = new Map() // FIX: Initialize driverLocks
        this.connectorIndices = {} // FIX: Initialize connectorIndices
        
        // FIX: Don't call _loadSettings in constructor - do it lazily
        this.settings = null
        this.settingsPromise = null
    }

    copy() {
        const newInstance = new ScrapingExecution()
        newInstance.connectors = { ...this.connectors }
        newInstance.drivers = this.drivers 
        newInstance.proxies = this.proxies 
        newInstance.rateLimiter = this.rateLimiter 
        newInstance.opt = { ...this.opt }
        newInstance.driverLocks = this.driverLocks // Share locks
        newInstance.connectorIndices = this.connectorIndices // Share indices
        newInstance.settings = this.settings // Share loaded settings
        newInstance.settingsPromise = this.settingsPromise // Share promise
        return newInstance
    }
    
    async _loadSettings() {
        if (this.settings) return this.settings
        
        if (!this.settingsPromise) {
            this.settingsPromise = (async () => {
                try {
                    this.settings = await getSettings()
                    log.info('Settings loaded for execution')
                    return this.settings
                } catch (error) {
                    log.error('Failed to load settings', error)
                    this.settingsPromise = null // Reset on error
                    throw error
                }
            })()
        }
        
        return this.settingsPromise
    }

    async _ensureSettings() {
        if (!this.settings) {
            await this._loadSettings()
        }
    }

    async _ensureDriversForSearch(connector_id) {
        if (this.drivers && this.drivers.isValid()) {
            return // Already initialized
        }

        log.info('Auto-initializing drivers for search', { connector_id })

        if (connector_id === '*') {
            // Initialize all connectors
            await this._initGlobalSearch('chromium')
        } else {
            // Initialize single connector
            const pool = new DriverPool(this.opt)
            await pool.addDriver(connector_id, 'chromium', null, this.opt)
            this.drivers = pool
            this.connectorIndices[connector_id] = 0
            log.success('Driver initialized for search', { connector: connector_id })
        }
    }
    
    async _configureRateLimiter(connectorName, skipTest = false) {
        await this._ensureSettings()
        
        if (this.opt.rateLimit !== 'auto') {
            log.debug('Manual rate limit set, skipping auto-configuration')
            return
        }
        
        const currentConfig = this.rateLimiter.getConfig()
        if (currentConfig.isConfigured && currentConfig._lastConnector === connectorName) {
            log.debug('Rate limiter already configured for connector', { connector: connectorName })
            return
        }
        
        if (this.settings && this.settings.hasDriverConfig(connectorName)) {
            const config = this.settings.getDriverConfig(connectorName)
            
            if (this.settings.isConfigStale(connectorName, this.opt.maxConfigAge)) {
                log.warn('Driver configuration is stale, will re-test', {
                    connector: connectorName,
                    maxAge: `${this.opt.maxConfigAge} days`
                })
                
                if (this.opt.testIfMissing && !skipTest) {
                    await this._testAndSaveRateLimit(connectorName)
                }
            } else {
                this.rateLimiter.setRate(config.reqsPerSecond)
                this.rateLimiter._lastConnector = connectorName
                log.success('Using saved rate limit configuration', {
                    connector: connectorName,
                    reqsPerSecond: config.reqsPerSecond,
                    testedAt: config.testedAt
                })
            }
        } else {
            log.info('No configuration found for connector', { connector: connectorName })
            
            if (this.opt.testIfMissing && !skipTest) {
                await this._testAndSaveRateLimit(connectorName)
            }
        }
    }
    
    async _testAndSaveRateLimit(connectorName) {
        log.info('Testing rate limit for connector', { connector: connectorName })
        
        const driver = this._getConnectorDriver(connectorName)
        if (!driver) {
            throw new Error(`No driver available for connector: ${connectorName}`)
        }
        
        const originalMode = this.rateLimiter.getConfig().mode
        this.rateLimiter.setRate(Infinity)
        
        let stats
        await driver.exec(async (driverApi) => {
            stats = await RateLimitTester(driverApi, {})
        })
        
        if (originalMode === 'auto') {
            this.rateLimiter.configureFromStats(stats)
            this.rateLimiter._lastConnector = connectorName
        }
        
        if (this.settings) {
            await this.settings.setDriverConfig(connectorName, stats)
        }
    }
    
    async _initGlobalSearch(browser='chromium') {
        if (this.drivers && this.drivers.isValid()) {
            const hasAllConnectors = Object.keys(Connectors).every(connectorId => {
                return this.drivers.pool.some(d => d.connector_id === connectorId)
            })
            
            if (hasAllConnectors) {
                log.debug('Global search already initialized, skipping')
                return
            }
        }
        
        log.info('Initializing global search', { 
            connectors: Object.keys(Connectors),
            browser 
        })
        
        const pool = new DriverPool(this.opt)
        
        for (const connectorId of Object.keys(Connectors)) {
            try {
                await pool.addDriver(connectorId, browser, null, this.opt)
                this.connectorIndices[connectorId] = 0
                log.debug('Driver added', { connector: connectorId })
            } catch (error) {
                log.error('Failed to add driver', error, { connector: connectorId })
            }
        }
        
        this.drivers = pool
        
        log.success('Global search initialized', { 
            connectors: Object.keys(Connectors),
            driversCount: this.drivers.length(),
            browser 
        })
    }

    _getConnectorDriver(connectorId) {
        if (!this.drivers.isValid()) return null
        
        const matchingDrivers = this.drivers.pool.filter(
            d => d.connector_id === connectorId
        )
        
        if (!matchingDrivers.length) {
            log.warn('No drivers found for connector', { connectorId })
            return null
        }
        
        if (!(connectorId in this.connectorIndices)) {
            this.connectorIndices[connectorId] = 0
        }
        
        const driver = matchingDrivers[this.connectorIndices[connectorId]]
        this.connectorIndices[connectorId] = 
            (this.connectorIndices[connectorId] + 1) % matchingDrivers.length
        
        return driver
    }
    
    /**
     * Ensures exclusive access to a specific driver instance.
     * Queues concurrent operations targeting the same driver so they execute sequentially.
     */
    async _lockDriver(driver, fn) {
        const driverId = driver.connector_id + '-' + this.drivers.pool.indexOf(driver)
        
        // Wait for previous operations
        while (this.driverLocks.has(driverId)) {
            await this.driverLocks.get(driverId)
        }
        
        // Creates new lock
        let resolveLock
        this.driverLocks.set(driverId, new Promise(resolve => resolveLock = resolve))
        
        try {
            return await fn()
        } finally {
            // Resolve
            this.driverLocks.delete(driverId)
            resolveLock()
        }
    }

    _getRandomConnectorId() {
        return this.drivers.pool[Math.floor(Math.random() * this.drivers.pool.length)]
    }

    /**
     * Ensures access to a defined connectorId, rate limiting the request
     */
    async lock(fn, connectorId=null) {
        if (!this.isValid()) throw new Error('ScrapingExecution is not valid')
        if (!connectorId) connectorId = _getRandomConnectorId().connector_id
        
        const driver = this._getConnectorDriver(connectorId)
        if (!driver) {
            throw new Error(`No driver available for connector: ${connectorId}`)
        }
        
        await this._configureRateLimiter(connectorId)
        await this.rateLimiter.throttle()
        
        const startTime = Date.now()
        
        const result = await this._lockDriver(driver, async () => {
            return await driver.exec(fn)
        })
        
        const duration = Date.now() - startTime
        
        log.debug('Connector request completed', { 
            connector: connectorId,
            durationMs: duration,
            rateLimitConfig: this.rateLimiter.getConfig()
        })
        
        return result
    }

    /**
     * Search for a title across single or multiple sources
     * @param {string} title - The title to search for
     * @param {string|null} connector_id - could be:
     *   - null: Progressive search (rotates through all connectors)
     *   - 'connector_name': Search only on specific connector
     *   - '*': Search on all connectors simultaneously
     * @param {Object} options - Search options
     * @param {boolean} options.sequential - If true, searches one at a time (default: true)
     * @returns {Promise<Object|Array>} Search results
     */
     async search(title, connector_id='*', opt={}) {
        const { sequential = false } = opt

        // FIX: Auto-initialize drivers if needed
        try {
            await this._ensureDriversForSearch(connector_id)
        } catch (error) {
            log.error('Failed to initialize drivers for search', error)
            throw new Error(`Failed to initialize drivers: ${error.message}`)
        }

        if (!this.drivers || !this.drivers.isValid()) {
            throw new Error("Driver initialization failed. Unable to perform search.")
        }

        const activeConnectors = Object.entries(this.connectors)
            .filter(([id, connector]) => connector_id === '*' || id === connector_id)
            .map(([id]) => id) // FIX: Just use the id, don't instantiate yet

        const searchJob = async (connectorId) => {
            try {
                const results = await this.drivers.exec(async (driver) => {
                    // Only proceed if this driver matches the connector we want
                    if (driver.name !== connectorId) {
                        return { 
                            connector: connectorId, 
                            count: 0, 
                            success: false, 
                            error: 'Driver mismatch',
                            results: []
                        }
                    }

                    await this.rateLimiter.throttle()

                    log.info(`Searching ${title} on ${connectorId}...`)
                    
                    await driver.page.goto(driver.getSearchUrl(title).render(), {
                        waitUntil: 'domcontentloaded',
                        timeout: 30000
                    })
                    
                    const searchResults = await driver.getSearchResults()
                    const items = []

                    for (const entry of searchResults) {
                        const item = {
                            title: await driver.getEntryField('title', entry),
                            link: await driver.getSearchEntryLink(entry),
                        }
                        
                        // Stream the result item via the onItem callback
                        if (typeof this.opt.onItem === 'function') {
                            this.opt.onItem({ event: 'message', data: { connector: connectorId, item } })
                        }
                        items.push(item)
                    }

                    return { 
                        connector: connectorId, 
                        count: items.length, 
                        success: true, 
                        results: items 
                    }
                })
                return results

            } catch (error) {
                log.error(`Search failed for ${connectorId}`, error)
                
                // Stream the error for this connector
                if (typeof this.opt.onItem === 'function') {
                    this.opt.onItem({ 
                        event: 'error', 
                        data: { 
                            connector: connectorId, 
                            error: error.message, 
                            success: false, 
                            retryable: true 
                        } 
                    })
                }
                
                return { 
                    connector: connectorId, 
                    count: 0, 
                    success: false, 
                    error: error.message,
                    results: []
                }
            }
        }

        // Execute searches
        if (sequential) {
            const allResults = []
            for (const connectorId of activeConnectors) {
                allResults.push(await searchJob(connectorId))
            }
            return allResults
        } else {
            return Promise.all(activeConnectors.map(searchJob))
        }
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

    async process(method, mode, opt={}) {
        const { target, title } = opt

        if (!this.drivers || !this.drivers.isValid()) {
            throw new Error("No drivers available. Please run /setup first.")
        }

        // This job acquires a single driver lock for the entire process
        return this.drivers.exec(async (driver) => {
            log.info(`Starting process: ${title} (${method}/${mode}) on ${driver.name}`)
            
            await this.rateLimiter.throttle() 
            
            await driver.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 })
            
            // Assuming this returns an array of chapter objects with title and link
            const chapters = await driver.getChapters() 
            
            const processChapter = async (chapter, index) => {
                await this.rateLimiter.throttle() 
                const chapterUrl = chapter.link instanceof Url ? chapter.link : new Url(chapter.link)
                
                const pages = await scrapeChapter(driver, chapterUrl, index, { /* pathParser options */ })
                
                // FIX: Stream result
                this.opt.onItem({ 
                    event: 'message', 
                    data: { 
                        connector: driver.name, 
                        item: { 
                            chapterTitle: chapter.title, 
                            chapterIndex: index, 
                            pages 
                        } 
                    } 
                })
                
                return pages
            }

            let allChapterResults = []

            // Since we only have one driver locked here, both modes run sequentially
            // from the perspective of this one driver.
            const chapterJobs = chapters.map((c, i) => () => processChapter(c, i + 1))

            if (mode === 'sequential' || chapterJobs.length === 1) {
                for (const job of chapterJobs) {
                    allChapterResults.push(await job())
                }
            } else if (mode === 'parallel') {
                log.warn('Parallel mode is running sequentially as only one driver is locked for this process job. Run multiple separate process jobs concurrently for true parallelism.')
                allChapterResults = await Promise.all(chapterJobs.map(job => job()))
            }


            log.success('Process complete', { title: title, chapters: allChapterResults.length })
            return allChapterResults

        }).catch(error => {
            log.error('Overall process failed', { error: error.message })
            throw error 
        })
    }

    async withDrivers(drivers) { 
        if (this.drivers) await this.drivers.dispose() // Dispose previous pool
        
        const pool = new DriverPool(this.opt)
        
        // Map the drivers array to include a unique proxy from the pool for each instance
        const driversWithProxies = drivers.map(d => {
            const proxy = this.proxies.getProxy()
            return [...d, proxy] // [connector_id, browserName, proxy]
        }); 

        // Build all drivers in parallel
        await Promise.all(driversWithProxies.map(
            async ([connector_id, browserName, proxy]) => 
                await pool.addDriver(connector_id, browserName, proxy, this.opt)
        ))

        this.drivers = pool
        return this
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

    async dispose() {
        if (this.drivers) {
            await this.drivers.dispose()
            this.drivers = null
        }
    }
}