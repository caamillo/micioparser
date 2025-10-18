import { build, buildMany } from "./driver.js";

;(async () => {
    const { browser, drivers } = await buildMany("mangaworld")
    const [ driver ] = drivers

    const results = await driver.search("GTO")
    const gto = results[0]
    
    await driver.scrapeBook(drivers, gto, 'default', 'parallel', { outputPath: 'downloads/vol-$vol/chap-$chap/page-$page.$ext' })
    await driver.page.screenshot({ path: 'out.png', fullPage: true })
})()