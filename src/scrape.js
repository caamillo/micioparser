import { Url, ProxyPool } from "./utils.js"
import log from "./log.js"
import { parseOutputOptions } from "./path.js"
import { DriverPool } from "./driver.js"

async function scrapeChapter(driver, chapterUrl, chapterIndex, pathParser, options = {}) {
    log.chapterStart(chapterIndex, chapterUrl.render())
    
    try {
        await driver.page.goto(chapterUrl.render())
        const firstImgSrc = await driver.getChapterLink()
        
        let page = Url.fromString(firstImgSrc)
        
        const pages = []
        let pageNum = 1
        
        while (true) {
            try {
                const res = await driver.page.goto(page.render())
                log.chapterPage(chapterIndex, pageNum, page.render())
                
                if (!res.ok()) throw new Error("Page not found")
                
                const outputPath = await pathParser.resolveAndEnsure({
                    chap: chapterIndex,
                    page: pageNum
                })
                
                await driver.page.screenshot({
                    path: outputPath,
                    fullPage: true
                })
                
                pages.push({ url: page.render(), path: outputPath })
                page.incFile()
                pageNum++
            } catch (error) {
                log.chapterComplete(chapterIndex, pageNum - 1)
                break
            }
        }
        
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
    const chapLinks = await driver.getAllChapterLinks()

    log.debug('Retrieved chapter links', { count: chapLinks.length })
    
    const out = []
    
    for (let i = 0; i < chapLinks.length; i++) {
        const res = await scrapeChapter(driver, chapLinks[i], i + 1, pathParser)
        out.push(res)
    }
    
    log.scrapeComplete({ chapters: out.length })
    return out
}

export async function bruteScrape(driver, options = {}) {
    const { 
        startUrl, 
        maxAttempts = 10, 
        onProgress = null,
        stopOnError = false 
    } = options
    
    if (!startUrl) {
        const error = new Error('startUrl is required for bruteforce')
        log.error('Bruteforce scrape configuration error', error)
        throw error
    }
    
    const pathParser = parseOutputOptions(options)
    log.info('Starting bruteforce scrape', { 
        startUrl, 
        maxAttempts, 
        outputPattern: pathParser.pattern 
    })
    
    let stats = { pagesScraped: 0, pagesFailed: 0, errors: [] }
    let currentVol = 1
    let currentChap = 1
    
    try {
        const firstCh = Url.fromString(startUrl)
        log.debug('Navigating to start URL', { url: firstCh.render() })
        
        const navRes = await driver.page.goto(firstCh.render())
        if (!navRes.ok()) {
            const error = new Error(`Failed to navigate to startUrl: ${firstCh.render()}`)
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
                
                const outputPath = await pathParser.resolveAndEnsure({
                    vol: currentVol,
                    chap: currentChap,
                    page: stats.pagesScraped + 1
                })
                
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
    return async (driver, chapLink, chapterIndex, options = {}) => {
        log.debug('Running item', { 
            method: coreFn.name,
            chapterIndex,
            url: chapLink.render() 
        })
        
        if (coreFn === defaultScrape) {
            const pathParser = parseOutputOptions(options)
            return scrapeChapter(driver, chapLink, chapterIndex, pathParser)
        }
        return coreFn(driver, { ...options, startUrl: chapLink.render() })
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
    let results
    await exec.lock(async (driver) => {
        await driver.go(options.startUrl)
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

    let chapLinks
    
    await exec.lock(async (driver) => {
        await driver.go(options?.startUrl)
        chapLinks = await driver.getAllChapterLinks()
    })
    
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
    const driver = exec.drivers.getDriver()
    const options = { ...exec.opt, ...opt }
    const { batchSize } = options

    log.info('Starting batch processing', { 
        method: coreFn.name,
        batchSize 
    })
    
    await driver.go(options?.startUrl)
    const chapLinks = await driver.getAllChapterLinks()
    
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
                const raw = await makeItemRunner(coreFn)(driver, chapLink, chapterIndex, options)
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

class RateLimiter {
    constructor(reqsPerSecond = Infinity) {
        this.reqsPerSecond = reqsPerSecond
        this.intervalMs = reqsPerSecond === Infinity ? 0 : 1000 / reqsPerSecond
        this.lastRequestTime = 0
        this.queue = []
        this.processing = false
        
        log.info('Rate limiter initialized', { 
            reqsPerSecond: reqsPerSecond === Infinity ? 'unlimited' : reqsPerSecond,
            intervalMs: this.intervalMs 
        })
    }

    async throttle() {
        if (this.reqsPerSecond === Infinity) return

        return new Promise((resolve) => {
            this.queue.push(resolve)
            this._processQueue()
        })
    }

    async _processQueue() {
        if (this.processing || this.queue.length === 0) return
        
        this.processing = true
        const now = Date.now()
        const timeSinceLastRequest = now - this.lastRequestTime
        const waitTime = Math.max(0, this.intervalMs - timeSinceLastRequest)
        
        if (waitTime > 0) {
            log.debug('Rate limit throttling', { waitMs: waitTime })
            await new Promise(resolve => setTimeout(resolve, waitTime))
        }
        
        this.lastRequestTime = Date.now()
        const resolve = this.queue.shift()
        this.processing = false
        
        resolve()
        
        if (this.queue.length > 0) {
            this._processQueue()
        }
    }

    getStats() {
        return {
            reqsPerSecond: this.reqsPerSecond,
            intervalMs: this.intervalMs,
            queueLength: this.queue.length,
            lastRequestTime: this.lastRequestTime
        }
    }
}

export class ScrapingExecution {
    constructor(opt={}) {
        opt = {
            proxy: new ProxyPool(),
            context_usage: 'multi-context',
            concurrency: 3,
            rateLimit: Infinity,
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
        this.rateLimiter = new RateLimiter(opt.rateLimit)
    }

    isValid() {
        return this.drivers.isValid()
    }

    copy() {
        return Object.create(
            Object.getPrototypeOf(this),
            Object.getOwnPropertyDescriptors(this)
        )
    }

    async lock(fn) {
        if (!this.isValid()) return

        await this.rateLimiter.throttle()
        
        const startTime = Date.now()
        const result = await this.drivers.exec(fn)
        const duration = Date.now() - startTime
        
        log.debug('Request completed', { 
            durationMs: duration,
            rateLimitStats: this.rateLimiter.getStats()
        })
        
        return result
    }

    async process(method="default", mode="single", opt={}) {
        try {
            method = Methods?.[method]
            if (!method) throw new Error('Invalid method.')
            
            mode = Modes?.[mode]
            if (!mode) throw new Error('Invalid mode.')

            this.startAt = Date.now()
            const results = await mode?.(method, this, opt)
            
            const totalTime = Date.now() - this.startAt
            log.success('Processing complete', {
                method: method.name,
                mode: mode.name,
                totalTimeMs: totalTime,
                rateLimitStats: this.rateLimiter.getStats()
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
        self.rateLimiter = new RateLimiter(self.opt.rateLimit)
        return self
    }

    addOption(opt={}) {
        this.opt = { ...this.opt, ...opt }
        
        if ('rateLimit' in opt) {
            this.rateLimiter = new RateLimiter(opt.rateLimit)
            log.info('Rate limiter updated', { 
                newRateLimit: opt.rateLimit 
            })
        }
    }

    setRateLimit(reqsPerPeriod, periodSeconds = 1) {
        const reqsPerSecond = reqsPerPeriod / periodSeconds
        this.opt.rateLimit = reqsPerSecond
        this.rateLimiter = new RateLimiter(reqsPerSecond)
        
        log.info('Rate limit configured', { 
            reqsPerPeriod,
            periodSeconds,
            effectiveReqsPerSecond: reqsPerSecond
        })
    }
}