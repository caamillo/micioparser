import { ScrapingExecution } from "./scrape.js"

;(async () => {
    let execution = await new ScrapingExecution()
    const { results } = await execution.search('GTO', 'mangaworld')
    console.log('Results', results)

    await execution.process('default', 'single', { target: results[0] })
})()