import { chromium, devices } from "playwright"
import log from "./log.js"

import mangaworld from "./connector/mangaworld.js"
import mangadex from "./connector/mangadex.js"

export const Browsers = {
    chromium: {
        driver: chromium,
        deviceDisplayName: 'chrome'
    }
}

export const Connectors = {
    mangaworld,
    mangadex
}

const buildConnector = (browser, ctx, page, connector) => ({
    ...connector(driverApis(page, connector)),
    browser,
    ctx
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
    constructor(connector_id='mangaworld', browser='chromium', opt={}) {
        this.connector_id = connector_id
        this.selectedBrowser = Browsers[browser]
        this.conn = Connectors[this.connector_id]
        this.browser = null
        this.context = null
        this.opt = { ...opt }
    }

    isValid() {
        if (this.conn) return true
        return false
    }

    async build() {
        try {
            if (!this.isValid()) throw new Error("Driver is not valid.")

            if (this.context?.ctx) {
                await this.context.ctx.close()
            }

            if (this.browser && this.opt.context_usage === 'multi-context') {
                await this.browser.close()
            }

            if (!this.browser || this.opt.context_usage === 'multi-context') {
                this.browser = await this.selectedBrowser.driver.launch()
            }

            const ctx = await this.browser.newContext({ 
                ...devices[this.selectedBrowser.deviceDisplayName], 
                proxy: this.opt.proxy.getProxy() 
            })

            this.context = { ctx, pages: [ await ctx.newPage() ], idx: 0 }

        } catch (err) {
            log.error('Build error', err)
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
            
            search: async (title) => {
                log.info('Starting manga search', { title, source: driver.name, browser: self.selectedBrowser.deviceDisplayName })
                
                let url = driver.getSearchUrl(title)
                await driver.page.goto(url.render(), { 
                    waitUntil: 'networkidle',
                    timeout: 30000 
                })
                
                // Wait for content to load
                await driver.page.waitForTimeout(2000)
                
                await driver.page.screenshot({
                    path: 'out.png',
                    fullPage: true
                })

                log.debug('Navigated to search page', { url: url.render() })
                
                const pages = (await driver.getPages()) ?? 1
                log.info('Found search result pages', { totalPages: pages, title })
                
                const results = []
                
                for (let i = 0; i < pages; i++) {
                    log.debug('Fetching search page', { page: i, totalPages: pages, url: url.render() })
                    
                    const entries = await driver.getSearchResults()
                    
                    if (!entries || !entries.length) {
                        log.warn('No entries found on page', { page: i })
                        continue
                    }
                    
                    log.debug('Found entries on page', { page: i, entriesCount: entries.length })
                    
                    const pageResults = await Promise.all(
                        entries.map(async entry => {
                            try {
                                const entryData = {}
                                for (const key of driver.opt.global_search_keys) {
                                    entryData[key] = await driver.getSearchEntry(key, entry)
                                }
                                return entryData
                            } catch (error) {
                                log.error('Failed to parse entry', error, { page: i + 1 })
                                return null
                            }
                        })
                    )
                    
                    const validResults = pageResults.filter(r => r !== null)
                    results.push(...validResults)
                    
                    log.success('Processed search page', { 
                        page: i + 1, 
                        totalPages: pages,
                        resultsOnPage: validResults.length,
                        totalResults: results.length 
                    })

                    url.incArg('page')
                    await driver.page.goto(url.render())
                }
                
                log.success('Search completed', { 
                    title, 
                    totalResults: results.length,
                    totalPages: pages 
                })
                
                return results
            },
        }
    }
}

export class DriverPool {
    constructor(opt={}) {
        this.pool = []
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
    
    async addDriver(connector_id, browser, opt={}) {
        const driver = new Driver(connector_id, browser, { ...this.opt, ...opt })
        await driver.build()
        this.pool.push(driver)
    }

    static async withDriver(connector_id, browser, opt={}) {
        const self = new DriverPool()
        await self.addDriver(connector_id, browser, opt)
        return self
    }

    static async withDrivers(drivers) {
        const self = new DriverPool()
        await Promise.all(drivers.map(async driver => await self.addDriver(...driver)))
        return self
    }
    
    async exec(fn) {
        try {
            if (!this.isValid()) throw new Error("DriverPool is not valid.")

            const driver = this.getDriver()
            if (!driver || !driver.isValid()) throw new Error([ "Driver is not valid", driver ])
    
            const result = await driver.exec(fn)
            return result
        } catch (err) {
            log.error('Execute error', err)
            throw err
        }
    }
}