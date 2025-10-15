import { build } from "./driver.js";

;(async () => {
    const driver = await build("mangaworld")
    const results = await driver.search("GTO")
    const gto = results[0]
    
    await driver.getBookStructure(gto)
    await driver.page.waitForTimeout(1e3)
    await driver.page.screenshot({ path: 'out.png', fullPage: true })
})()