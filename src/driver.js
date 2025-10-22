import { chromium, devices } from "playwright"
import log from "./log.js"

import mangaworld from "./connector/mangaworld.js"
import mangadex from "./connector/mangadex.js"

const Browsers = {
    chromium: {
        driver: chromium,
        deviceDisplayName: 'chrome'
    }
}

const Connectors = {
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
    
            const browser = await this.selectedBrowser.driver.launch()
            const ctx = await browser.newContext({ ...devices[this.selectedBrowser.deviceDisplayName], proxy: this.opt.proxy.getProxy() })

            this.context = { ctx, pages: [ await ctx.newPage() ], idx: 0, }

        } catch (err) {
            log.error('Build error', err)
        }
    }

    async exec(fn) {
        try {
            if (!this.isValid()) throw new Error("Driver is not valid.")
    
            const result = await fn(this.getDriverApis())
            switch (this.opt.context_usage) {
                case 'same-context':
                    break
                case 'multi-context':
                    await this.build()
            }

            return result
        } catch (err) {
            log.error('Execute error', err)
        }
    }

    getDriverApis() {
        if (!this.isValid() && this.context) return

        const page = this.context.pages[this.context.idx]
        
        const api = {
            page,

            goHome: async () =>
                await page.goto(this.conn().ENDPOINT_URL),
            go: async (book) =>
                await page.goto(typeof book === 'object' ? book?.link : book),
            scrapeBook: async (drivers, book, method = 'default', mode = 'single', options = {}) => {
                if (!Array.isArray(drivers)) drivers = [ drivers ]

                const scrapeMethod = drivers?.[0]?.scrape?.[method]?.[mode]
                if (!scrapeMethod) {
                    throw new Error(`Scrape method ${method}.${mode} not found`)
                }
                
                const mergedOptions = { ...options, startUrl: book.link }
                const n_drivers = drivers.length > 1 ? drivers : drivers[0]
                
                switch (mode) {
                    case 'single':
                        return await scrapeMethod(n_drivers, mergedOptions)
                    
                    case 'parallel':
                        const concurrency = options.concurrency || 3
                        return await scrapeMethod(n_drivers, concurrency, mergedOptions)
                    
                    case 'batch':
                        const batchSize = options.batchSize || 5
                        return await scrapeMethod(n_drivers, batchSize, mergedOptions)
                    
                    default:
                        throw new Error(`Unknown mode: ${mode}`)
                }
            }
        }
        const apiConn = this.conn(api)
        return { ...api, ...apiConn }
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
        this.idx = this.idx + 1 % this.pool.length
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
            if (!driver.isValid()) throw new Error([ "Driver is not valid", driver ])
    
            const result = await driver.exec(fn)
            return result
        } catch (err) {
            log.error('Execute error', err)
        }
    }
}