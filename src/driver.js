import { chromium, devices } from "playwright"
import { Url } from "./utils.js"
import log from "./log.js"

import mangaworld from "./connector/mangaworld.js"
import mangadex from "./connector/mangadex.js"
import animeclick from "./connector/animeclick.js"

export const Browsers = {
    chromium: {
        driver: chromium,
        deviceDisplayName: 'chrome'
    }
}

export const Connectors = {
    mangaworld,
    mangadex,
    // animeclick
}

const buildConnector = (browser, ctx, page, connector) => ({
    ...connector(driverApis(page, connector)),
    browser,
    ctx
})

const driverApis = (page, connector) => ({
    page,
    Url,
    log,
    name: connector.name,
})

export const build = async (connector_id) => {
    const browser = await chromium.launch()
    const ctx = await browser.newContext(devices['chrome'])
    const page = await ctx.newPage()

    const connector = Connectors[connector_id]
    if (!connector) throw "Connector not found."

    return buildConnector(browser, ctx, page, connector)
}

export const buildMany = async (connector_id, count = 3) => {
    const browser = await chromium.launch()
    const connector = Connectors[connector_id]
    if (!connector) throw "Connector not found."

    const drivers = []
    for (let i = 0; i < count; i++) {
        const ctx = await browser.newContext(devices['chrome'])
        const page = await ctx.newPage()
        drivers.push(buildConnector(browser, ctx, page, connector))
    }

    return { browser, drivers }
}

class Driver {
    constructor(connector_id, browserName, opt = {}) {
        this.connector_id = connector_id
        this.browserName = browserName
        this.opt = opt
        this.browser = null
        this.ctx = null
        this.page = null
        this.name = Connectors[connector_id]?.name || 'unknown'
        this.connector = null
    }

    isValid() {
        if (this.conn) return true
        return false
    }

    async build() {
        const browserType = Browsers[this.browserName].driver
        const proxy = this.opt.proxy

        this.browser = await browserType.launch({
        })
        
        const contextOptions = {
            ...devices['chrome'],
            bypassCSP: true,
            ...(proxy && proxy.isValid() ? {
                proxy: {
                    server: `http://${proxy.server}`,
                    username: proxy.user,
                    password: proxy.pass,
                }
            } : {})
        }

        this.ctx = await this.browser.newContext(contextOptions)
        this.page = await this.ctx.newPage()

        const connectorFn = Connectors[this.connector_id]
        if (!connectorFn) throw new Error(`Connector '${this.connector_id}' not found.`)

        this.connector = {
            ...connectorFn(driverApis(this.page, connectorFn)),
            browser: this.browser,
            ctx: this.ctx
        }

        log.debug('Driver built', { connector: this.name, proxy: proxy?.server || 'none' })
    }

    getConnector() {
        return this.connector
    }

    async close() {
        if (this.browser) {
            await this.browser.close()
            this.browser = null
            this.ctx = null
            this.page = null
            this.connector = null
            log.debug('Driver closed', { connector: this.name })
        }
    }

    async exec(fn) {
        try {
            if (!this.isValid()) throw new Error("Driver is not valid.")

            if (this.opt.context_usage === 'multi-context') {
                log.debug('Rebuilding context for multi-context mode', { 
                    connector: this.connector_id 
                })
                await this.build()
            }

            return await fn(this.getDriverApis())
        } catch (err) {
            log.error('Execute error', err)
            throw err
        }
    }

    async close() {
        if (this.context?.ctx) {
            await this.context.ctx.close()
        }
        if (this.browser) {
            await this.browser.close()
        }
    }

    getDriverApis() {
        if (!this.isValid() || !this.context) return

        const self = this
        
        const api = {
            get page() {
                return self.context.pages[self.context.idx]
            },
            opt: this.opt,

            goHome: async () => {
                const currentPage = self.context.pages[self.context.idx]
                await currentPage.goto(self.conn().ENDPOINT_URL)
            },

            go: async (book) => {
                const currentPage = self.context.pages[self.context.idx]
                await currentPage.goto(typeof book === 'object' ? book?.link : book)
            },
        }

        const driver = this.conn(api)

        return {
            ...api,
            ...driver,
            
            // FIXED: Add options parameter for progress callbacks
            search: async (title, searchOptions = {}) => {
                const { onItemProgress } = searchOptions
                
                log.info('Starting manga search', { 
                    title, 
                    source: driver.name, 
                    browser: self.selectedBrowser.deviceDisplayName 
                })
                
                let url = driver.getSearchUrl(title)
                await driver.page.goto(url.render(), { 
                    waitUntil: 'networkidle',
                    timeout: 30e3
                })

                log.debug('Navigated to search page', { url: url.render() })
                
                const pages = (await driver.getPages()) ?? 1
                log.info('Found search result pages', { totalPages: pages, title })
                
                const results = []
                
                for (let i = 0; i < pages; i++) {
                    log.debug('Fetching search page', { 
                        page: i, 
                        totalPages: pages, 
                        url: url.render() 
                    })
                    
                    const entries = await driver.getSearchResults()
                    
                    if (!entries || !entries.length) {
                        log.warn('No entries found on page', { page: i })
                        continue
                    }
                    
                    log.debug('Found entries on page', { 
                        page: i, 
                        entriesCount: entries.length 
                    })
                    
                    // FIRST: Extract all the links from the current page
                    const entryLinks = []
                    for (let j = 0; j < entries.length; j++) {
                        try {
                            const link = await driver.getSearchEntryLink(entries[j])
                            entryLinks.push(Url.fromString(link))
                        } catch (error) {
                            log.error('Failed to get entry link', error, { index: j + 1 })
                            entryLinks.push(null)
                        }
                    }
                    
                    // SECOND: Navigate to each link and fetch data
                    for (let j = 0; j < entryLinks.length; j++) {
                        const link = entryLinks[j]
                        if (!link) {
                            continue
                        }
                        
                        try {
                            log.info('Fetching book: ' + (j + 1), { url: link.render() })
                            await driver.page.goto(link.render(), { 
                                waitUntil: 'networkidle',
                                timeout: 60e3
                            })
                            await driver.page.waitForTimeout(2e3)

                            const entryData = { link }
                            for (const key of driver.opt.global_search_keys) {
                                entryData[key] = await driver.getEntryField(key)
                            }
                            
                            results.push(entryData)
                            
                            // FIXED: Send item immediately via progress callback
                            if (typeof onItemProgress === 'function') {
                                onItemProgress(entryData)
                            }
                            
                        } catch (error) {
                            log.error('Failed to parse entry', error, { page: j + 1 })
                        }
                    }
                    
                    log.success('Processed search page', { 
                        page: i + 1, 
                        totalPages: pages,
                        resultsOnPage: entryLinks.filter(l => l !== null).length,
                        totalResults: results.length 
                    })

                    // Navigate to next search page if there are more pages
                    if (i < pages - 1) {
                        url.incArg('page')
                        await driver.page.goto(url.render(), {
                            waitUntil: 'networkidle',
                            timeout: 30e3
                        })
                    }
                }
                
                log.success('Search completed', { 
                    title, 
                    totalResults: results.length,
                    totalPages: pages 
                })
                
                return results
            }
        }
    }
}

export class DriverPool {
    constructor(opt={}) {
        this.pool = []
        this.busy = new Set()
        this.idx = 0
        this.opt = { ...opt }
    }

    length() {
        return this.pool.length
    }

    isValid() {
        return this.pool.length
    }

    getDriver() {
        if (!this.pool.length) return

        const driver = this.pool[this.idx]
        this.idx = (this.idx + 1) % this.pool.length
        return driver
    }

    getAvailableDriver() {
        if (!this.pool.length) return null

        for (let i = 0; i < this.pool.length; i++) {
            const driver = this.pool[(this.idx + i) % this.pool.length]
            if (!this.busy.has(driver)) {
                // Advance the index only on successful acquisition for round-robin fairness
                this.idx = (this.idx + i + 1) % this.pool.length
                return driver
            }
        }
        return null // All drivers are busy
    }
    
    async addDriver(connector_id, browserName, proxy, opt={}) { 
        const driver = new Driver(connector_id, browserName, { 
            ...this.opt, 
            ...opt, 
            proxy
        }) 
        await driver.build()
        this.pool.push(driver)
    }


    static async withDriver(connector_id, browser, proxy, opt={}) { // Updated signature
        const self = new DriverPool()
        await self.addDriver(connector_id, browser, proxy, opt)
        return self
    }

    static async withDrivers(drivers) { 
        const self = new DriverPool()
        await Promise.all(drivers.map(async ([connector_id, browserName, proxy]) => 
            await self.addDriver(connector_id, browserName, proxy)
        ))
        return self
    }
    
    async exec(fn) {
        if (!this.isValid()) {
            throw new Error("DriverPool is not valid (no drivers built).")
        }

        let driver = this.getAvailableDriver()
        
        // FIX: Add timeout to prevent infinite waiting
        const maxWaitTime = 60000 // 60 seconds
        const startTime = Date.now()
        
        while (!driver) {
            if (Date.now() - startTime > maxWaitTime) {
                throw new Error("Timeout waiting for available driver. All drivers are busy.")
            }
            
            await new Promise(resolve => setTimeout(resolve, 100))
            driver = this.getAvailableDriver()
        }

        this.busy.add(driver) 
        
        try {
            return await fn(driver.getConnector()) 
        } finally {
            this.busy.delete(driver) 
        }
    }

    async dispose() {
        await Promise.all(this.pool.map(driver => driver.close()))
        this.pool = []
        this.busy.clear()
        this.idx = 0
    }
}