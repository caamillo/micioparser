import { chromium, devices } from "playwright"
import mangaworld from "./connector/mangaworld.js"

const Connectors = {
    mangaworld
}

const driverApis = (page, connector) => ({
    page,
    goHome: async () =>
        await page.goto(connector().ENDPOINT_URL),
    go: async (book) =>
        await page.goto(book.link)
})

const buildConnector = (browser, ctx, page, connector) => ({
    ...connector(driverApis(page, connector)),
    browser,
    ctx,
})

export const build = async (connector_id) => {
    const browser = await chromium.launch()
    const ctx = await browser.newContext(devices['chrome'])
    const page = await ctx.newPage()

    const connector = Connectors[connector_id]
    if (!connector)
        throw "Connector not found."

    return buildConnector(browser, ctx, page, connector)
}