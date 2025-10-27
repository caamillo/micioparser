import { ScrapingExecution } from "./scrape.js"

;(async () => {
    let execution = await new ScrapingExecution({
        outputPath: 'downloads/vol-$vol/chap-$chap/page-$page.$ext',
        rateLimit: 'auto'
    })
        .withDrivers([
            ...(new Array(3).fill([ 'mangadex', 'chromium' ]))
        ])
   
    const results = await execution.lock(async (driver) => await driver.search("GTO"))
    const gto = results[0]
    
    await execution.process('default', 'single', { startUrl: gto.link })
})()