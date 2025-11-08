import { Url, ProxyPool } from "./utils.js"
import log from "./log.js"
import { parseOutputOptions } from "./path.js"
import { DriverPool, Connectors } from "./driver.js"
import { NavigationLock, ContextMode } from "./navigation.js"
import { WorkerPool, TaskFactory } from "./worker.js"
import { getSettings } from "./settings.js"

export class ScrapingExecution {
    constructor(opt = {}) {
        this.drivers = null
        this.workerPool = null
        this.navigationLock = null
        this.proxies = new ProxyPool()
        
        this.opt = {
            size: opt.size || 1, // Worker pool size
            contextMode: opt.contextMode || null, // Auto-detect if null
            onItem: opt.onItem || (() => {}),
            ...opt
        }

        // Auto-detect context mode if not specified
        if (!this.opt.contextMode) {
            this.opt.contextMode = this.proxies.pool.length > 0 
                ? ContextMode.MULTI 
                : ContextMode.SINGLE
        }

        this.settings = null
        this.settingsPromise = null
    }

    static withOptions(opt = {}) {
        return new ScrapingExecution(opt)
    }

    copy() {
        const newInstance = new ScrapingExecution(this.opt)
        newInstance.drivers = this.drivers
        newInstance.workerPool = this.workerPool
        newInstance.navigationLock = this.navigationLock
        newInstance.proxies = this.proxies
        newInstance.settings = this.settings
        newInstance.settingsPromise = this.settingsPromise
        return newInstance
    }

    async _loadSettings() {
        if (this.settings) return this.settings

        if (!this.settingsPromise) {
            this.settingsPromise = (async () => {
                try {
                    this.settings = await getSettings()
                    log.info('Settings loaded')
                    return this.settings
                } catch (error) {
                    log.error('Failed to load settings', error)
                    this.settingsPromise = null
                    throw error
                }
            })()
        }

        return this.settingsPromise
    }

    /**
     * Initialize drivers and worker pool
     */
    async _initialize(connectorIds) {
        // Create navigation lock if not exists
        if (!this.navigationLock) {
            this.navigationLock = new NavigationLock({
                contextMode: this.opt.contextMode,
                proxyPool: this.proxies
            })
        }

        // Create driver pool if not exists or missing connectors
        if (!this.drivers || !connectorIds.every(id => this.drivers.hasDriver(id))) {
            if (this.drivers) {
                await this.drivers.dispose()
            }

            this.drivers = await DriverPool.withConnectors(connectorIds, {
                contextMode: this.opt.contextMode,
                proxyPool: this.proxies
            })

            log.success('Drivers initialized', {
                connectors: connectorIds,
                contextMode: this.opt.contextMode
            })
        }

        // Create worker pool if not exists
        if (!this.workerPool) {
            this.workerPool = new WorkerPool(this.opt.size, this.navigationLock)
            await this.workerPool.start()

            log.success('Worker pool started', {
                size: this.opt.size
            })
        }
    }

    /**
     * Search for manga across connectors
     */
    async search(title, connector_id = '*', opt = {}) {
        const { sequential = false, deep = false } = opt

        // Determine which connectors to use
        const connectorIds = connector_id === '*' 
            ? Object.keys(Connectors)
            : [connector_id]

        // Initialize system
        await this._initialize(connectorIds)

        log.info('Starting search', {
            title,
            connectors: connectorIds,
            mode: sequential ? 'sequential' : 'parallel',
            deep,
            workerSize: this.opt.size
        })

        // Create search tasks for each connector
        const searchTasks = connectorIds.map(connId => 
            this._createSearchTask(connId, title, { deep })
        )

        // Execute tasks
        let initialResults
        if (sequential) {
            // Sequential: execute one at a time
            initialResults = []
            for (const task of searchTasks) {
                initialResults.push(await this.workerPool.submit(task))
            }
        } else {
            // Parallel: submit all tasks and let workers handle them
            initialResults = await this.workerPool.submitAll(searchTasks)
        }

        const finalResults = [];
        for (const res of initialResults) {
            if (res.deepTaskPromises) {
                // If the worker submitted deep tasks, the initial result is shallow.
                // The worker that ran the 'search' task is now free.
                // We await the promises here in the main thread.
                log.debug('Awaiting deep task resolution', { connector: res.connector, count: res.deepTaskPromises.length });
                
                try {
                    const deepItems = await Promise.all(res.deepTaskPromises);
                    finalResults.push({
                        ...res,
                        results: deepItems, // Replace shallow results with deep results
                        deepTaskPromises: undefined // Clean up
                    });
                } catch (error) {
                    log.error('One or more deep tasks failed for connector', error, { connector: res.connector });
                    finalResults.push(res); // Push original partial result on error
                }
            } else {
                // Not deep search, or an error occurred in the search phase
                finalResults.push(res);
            }
        }

        const totalResults = finalResults.reduce((sum, r) => sum + (r.count || 0), 0)

        log.success('Search completed', {
            title,
            connectors: finalResults.length,
            totalResults
        })

        return finalResults
    }

    /**
     * Create search task
     */
    _createSearchTask(connectorId, title, options = {}) {
        const { deep = false } = options

        return TaskFactory.search(connectorId, title, {
            execute: async () => {
                try {
                    // Navigate to search page (lock handled by worker)
                    await this.drivers.exec(connectorId, async (driver) => {
                        // Check if multi-context mode and recreate context
                        if (this.navigationLock.contextMode === ContextMode.MULTI) {
                            const proxy = this.navigationLock.getNextProxy()
                            await this.drivers.build(connectorId, proxy)
                        }

                        const searchUrl = driver.getSearchUrl(title)
                        await driver.page.goto(searchUrl.render(), {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        })
                    })

                    // Extract search results
                    const entries = await this.drivers.exec(connectorId, async (driver) => {
                        return await driver.getSearchResults()
                    })

                    if (!entries || entries.length === 0) {
                        log.info('No results found', { connector: connectorId, title })
                        return {
                            connector: connectorId,
                            count: 0,
                            success: true,
                            results: []
                        }
                    }

                    log.debug('Found search entries', {
                        connector: connectorId,
                        count: entries.length
                    })

                    // If deep search, create tasks for each entry
                    if (deep) {
                        const deepTaskPromises = entries.map(item =>
                            // Submit each task, which returns a Promise immediately
                            this.workerPool.submit(this._createDeepSearchTask(connectorId, title, item))
                        );

                        return {
                            connector: connectorId,
                            count: entries.length,
                            success: true,
                            results: entries, // Initial results
                            deepTaskPromises: deepTaskPromises 
                        };
                    } else {
                        // Stream results
                        entries.forEach(item => {
                            this.opt.onItem({
                                event: 'message',
                                data: { connector: connectorId, item }
                            })
                        })

                        return {
                            connector: connectorId,
                            count: entries.length,
                            success: true,
                            results: entries
                        }
                    }
                } catch (error) {
                    log.error('Search failed', error, { connector: connectorId, title })

                    this.opt.onItem({
                        event: 'error',
                        data: {
                            connector: connectorId,
                            error: error.message,
                            success: false
                        }
                    })

                    return {
                        connector: connectorId,
                        count: 0,
                        success: false,
                        error: error.message,
                        results: []
                    }
                }
            }
        })
    }

    /**
     * Create deep search task (navigate to detail page and extract fields)
     */
    _createDeepSearchTask(connectorId, title, item) {
        return TaskFactory.deepSearch(connectorId, title, item, {
            execute: async () => {
                try {
                    log.debug('Deep search entry', { connector: connectorId, item })

                    // Navigate to detail page (lock handled by worker)
                    await this.drivers.exec(connectorId, async (driver) => {
                        // Multi-context: recreate context with new proxy
                        if (this.navigationLock.contextMode === ContextMode.MULTI) {
                            const proxy = this.navigationLock.getNextProxy()
                            await this.drivers.build(connectorId, proxy)
                        }

                        await driver.page.goto(item.link, {
                            waitUntil: 'domcontentloaded',
                            timeout: 30000
                        })
                    })

                    // Extract all fields
                    const fields = await this.drivers.exec(connectorId, async (driver) => {
                        const fieldKeys = await driver.getEntryField('', true)
                        console.log(fieldKeys)
                        const data = { ...item }

                        for (const key of fieldKeys) {
                            try {
                                data[key] = await driver.getEntryField(key)
                            } catch (error) {
                                log.debug(`Failed to get field ${key}`, { error: error.message })
                                data[key] = null
                            }
                        }

                        return data
                    })

                    // Stream result
                    this.opt.onItem({
                        event: 'message',
                        data: { connector: connectorId, item: fields }
                    })

                    return fields
                } catch (error) {
                    log.error('Deep search failed', error, {
                        connector: connectorId,
                        item: item.title
                    })
                    return item
                }
            }
        })
    }

    /**
     * Process manga (scrape chapters)
     */
    async process(method, mode, opt = {}) {
        const { target, title, size } = opt

        if (!target) {
            throw new Error("Target URL is required")
        }

        // Extract connector from URL or use first available
        const connectorId = this._detectConnector(target)
        
        // Initialize with specific connector
        await this._initialize([connectorId])

        // Override worker size if specified
        if (size && size !== this.opt.size) {
            await this.workerPool.stop()
            this.workerPool = new WorkerPool(size, this.navigationLock)
            await this.workerPool.start()
            this.opt.size = size
        }

        log.info('Starting process', {
            method,
            mode,
            title,
            size: this.opt.size,
            target
        })

        // Get target URL
        const targetUrl = typeof target === 'object'
            ? (target.link || target.url)
            : target

        // Get chapters list
        const chapters = await this.drivers.exec(connectorId, async (driver) => {
            await driver.page.goto(targetUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            })

            const volumes = await driver.getAllChapterLinks()

            // Flatten chapters
            const allChapters = []
            for (const volume of volumes) {
                for (const chapterUrl of volume.chapters) {
                    allChapters.push({
                        url: chapterUrl,
                        volume: volume.volume
                    })
                }
            }

            return allChapters
        })

        log.info('Chapters retrieved', { count: chapters.length })

        // Create chapter scrape tasks
        const chapterTasks = chapters.map((chapter, idx) =>
            this._createChapterTask(connectorId, chapter, idx + 1, opt)
        )

        // Execute based on mode
        let results
        if (mode === 'sequential') {
            results = []
            for (const task of chapterTasks) {
                results.push(await this.workerPool.submit(task))
            }
        } else {
            // Parallel mode: workers will handle distribution
            results = await this.workerPool.submitAll(chapterTasks)
        }

        return results
    }

    /**
     * Create chapter scrape task
     */
    _createChapterTask(connectorId, chapter, chapterIndex, opt) {
        return TaskFactory.chapterScrape(connectorId, chapter, chapterIndex, {
            execute: async () => {
                const chapterUrl = chapter.url
                const pathParser = parseOutputOptions(opt)

                log.info('Scraping chapter', {
                    chapterIndex,
                    url: chapterUrl.render()
                })

                try {
                    // Navigate to chapter (lock handled by worker)
                    await this.drivers.exec(connectorId, async (driver) => {
                        // Multi-context: recreate context
                        if (this.navigationLock.contextMode === ContextMode.MULTI) {
                            const proxy = this.navigationLock.getNextProxy()
                            await this.drivers.build(connectorId, proxy)
                        }

                        await driver.page.goto(chapterUrl.render(), {
                            waitUntil: 'networkidle',
                            timeout: 30000
                        })

                        await driver.page.waitForTimeout(1000)
                    })

                    // Scrape pages
                    const pages = []
                    let pageNum = 1

                    const maxPages = await this.drivers.exec(connectorId, async (driver) => {
                        return typeof driver.getPageCount === 'function'
                            ? await driver.getPageCount()
                            : null
                    })

                    while (true) {
                        try {
                            // Get image
                            const imageHandle = await this.drivers.exec(connectorId, async (driver) => {
                                return await driver.getPage()
                            })

                            if (!imageHandle) {
                                log.warn('No image found', { pageNum })
                                break
                            }

                            const src = await imageHandle.getAttribute('src')
                            pages.push({ pageNum, src })

                            log.debug('Page scraped', { pageNum, maxPages })

                            // Navigate to next page
                            const navigated = await this.drivers.exec(connectorId, async (driver) => {
                                if (typeof driver.getNextPage === 'function') {
                                    return await driver.getNextPage()
                                }
                                return false
                            })

                            if (!navigated) {
                                log.debug('No more pages', { pageNum })
                                break
                            }

                            pageNum++

                            if (maxPages && pageNum > maxPages) {
                                log.debug('Max pages reached', { pageNum, maxPages })
                                break
                            }
                        } catch (error) {
                            log.error('Page scraping failed', error, { pageNum })
                            break
                        }
                    }

                    const result = {
                        chapterIndex,
                        chapterUrl: chapterUrl.render(),
                        pages
                    }

                    log.success('Chapter scraped', {
                        chapterIndex,
                        pagesCount: pages.length
                    })

                    // Stream result
                    this.opt.onItem({
                        event: 'message',
                        data: { chapterIndex, result }
                    })

                    return result
                } catch (error) {
                    log.error('Chapter processing failed', error, { chapterIndex })
                    return { error: error.message }
                }
            }
        })
    }

    /**
     * Detect connector from URL
     */
    _detectConnector(url) {
        const urlStr = typeof url === 'object' ? (url.link || url.url) : url

        for (const [id, connector] of Object.entries(Connectors)) {
            const connectorInstance = connector({ page: null, Url, log, name: id })
            if (urlStr.includes(connectorInstance.ENDPOINT_URL)) {
                return id
            }
        }

        // Default to first connector
        return Object.keys(Connectors)[0]
    }

    isValid() {
        return this.drivers && this.drivers.isValid()
    }

    /**
     * Set option
     */
    setOption(key, value) {
        this.opt[key] = value

        // Handle specific option changes
        if (key === 'size') {
            // Worker pool size change requires restart
            if (this.workerPool) {
                this.workerPool.stop().then(() => {
                    this.workerPool = new WorkerPool(value, this.navigationLock)
                    return this.workerPool.start()
                })
            }
        } else if (key === 'contextMode') {
            if (this.navigationLock) {
                this.navigationLock.setContextMode(value)
            }
        }
    }

    /**
     * Get status
     */
    getStatus() {
        return {
            initialized: this.isValid(),
            drivers: this.drivers?.getStatus(),
            workers: this.workerPool?.getStatus(),
            navigation: this.navigationLock?.getStatus(),
            options: {
                size: this.opt.size,
                contextMode: this.opt.contextMode
            }
        }
    }

    /**
     * Dispose all resources
     */
    async dispose() {
        if (this.workerPool) {
            await this.workerPool.stop()
            this.workerPool = null
        }

        if (this.drivers) {
            await this.drivers.dispose()
            this.drivers = null
        }

        this.navigationLock = null
    }

    /**
     * Initialize with specific connectors and proxies
     */
    async withDrivers(connectorConfigs) {
        // Extract unique connector IDs
        const connectorIds = [...new Set(connectorConfigs.map(([id]) => id))]

        // Add proxies if provided
        connectorConfigs.forEach(([_, __, proxy]) => {
            if (proxy && proxy.isValid()) {
                this.proxies.addProxy(proxy.server, proxy.user, proxy.pass)
            }
        })

        // Auto-detect context mode
        if (this.proxies.pool.length > 0 && this.opt.contextMode === ContextMode.SINGLE) {
            this.opt.contextMode = ContextMode.MULTI
            log.info('Auto-switched to multi-context mode (proxies detected)')
        }

        // Initialize
        await this._initialize(connectorIds)

        return this
    }
}