import { chromium, devices } from "playwright"
import { scrapeMethods } from "./scrape.js"
import mangaworld from "./connector/mangaworld.js"

const Connectors = {
    mangaworld
}

const driverApis = (page, connector) => ({
    page,
    scrape: scrapeMethods,

    goHome: async () =>
        await page.goto(connector().ENDPOINT_URL),
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

})

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
