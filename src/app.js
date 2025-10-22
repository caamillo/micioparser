import { ScrapingExecution } from "./scrape.js";

;(async () => {
    let execution = await new ScrapingExecution({ outputPath: 'downloads/vol-$vol/chap-$chap/page-$page.$ext' })
        .withDrivers([
            ...(new Array(3).fill([ 'mangaworld', 'chromium' ]))
        ])

    const results = await execution.lock(async (driver) => await driver.search("GTO"))
    const gto = results[0]

    execution.addOption({ startUrl: gto.link })

    await execution.process()
})()