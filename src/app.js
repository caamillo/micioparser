import { Scraper } from "./scrape.js"

;(async () => {
    let execution = new Scraper()
    const { results } = await execution.search('GTO', 'mangaworld')
    console.log('Results', results)

    await execution.process('default', 'single', { target: results[0] })
})()