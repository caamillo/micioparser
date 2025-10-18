import { childText, childrenText, childAttribute, Url } from "../utils.js"
import log from "../log.js"

const ENDPOINT_URL = 'https://mangaworld.cx'
const CDN_ENDPOINT_URL = 'https://cdn.mangaworld.cx'

export default (driver) => ({
    ...driver,
    name: 'mangaworld',
   
    search: async (title) => {
        log.info('Starting manga search', { title, source: 'mangaworld' })
        
        let url = new Url(ENDPOINT_URL, ["archive"], "", {
            "keyword": title,
            "page": 1
        })
        
        await driver.page.goto(url.render())
        log.debug('Navigated to search page', { url: url.render() })
        
        const pages = parseInt(await (await driver.page.$('.page-item.last > a.page-link')).textContent())
        log.info('Found search result pages', { totalPages: pages, title })
        
        const results = []
        
        for (let i = 0; i < pages; i++) {
            url = new Url(ENDPOINT_URL, ["archive"], "", {
                "keyword": title,
                "page": i + 1
            })
            
            log.debug('Fetching search page', { page: i + 1, totalPages: pages, url: url.render() })
            await driver.page.goto(url.render())
            
            const entries = await driver.page.$$('.comics-grid > .entry')
            log.debug('Found entries on page', { page: i + 1, entriesCount: entries.length })
            
            const pageResults = await Promise.all(
                entries.map(async entry => {
                    try {
                        return {
                            link: await childAttribute(entry, 'a.thumb', 'href'),
                            banner: await childAttribute(entry, 'a.thumb > img', 'src'),
                            title: await childText(entry, '.manga-title'),
                            type: await childText(entry, '.genre > a'),
                            author: await childText(entry, '.author > a'),
                            artist: await childText(entry, '.artist > a'),
                            genres: await childrenText(entry, '.genres > a'),
                            short_plot: await entry.$eval('.story', el => {
                                const clone = el.cloneNode(true)
                                clone.querySelector('span').remove()
                                return clone.textContent.trim()
                            })
                        }
                    } catch (error) {
                        log.error('Failed to parse entry', error, { page: i + 1 })
                        return null
                    }
                })
            )
            
            // Filter out any null results from failed parsing
            const validResults = pageResults.filter(r => r !== null)
            results.push(...validResults)
            
            log.success('Processed search page', { 
                page: i + 1, 
                totalPages: pages,
                resultsOnPage: validResults.length,
                totalResults: results.length 
            })
        }
       
        log.success('Search completed', { 
            title, 
            totalResults: results.length,
            totalPages: pages 
        })
        
        return results
    },
    
    getAllChapterLinks: async () => {
        log.debug('Retrieving all chapter links')
        
        try {
            const anchors = await driver.page.$$('.chapters-wrapper a.chap')
            log.debug('Found chapter anchors', { count: anchors.length })
            
            const links = await Promise.all(
                anchors.map(async a => {
                    try {
                        const href = await a.getAttribute('href')
                        return Url.fromString(href)
                    } catch (error) {
                        log.error('Failed to get chapter link', error)
                        return null
                    }
                })
            )
            
            const validLinks = links.filter(link => link !== null)
            log.success('Retrieved chapter links', { count: validLinks.length })
            
            return validLinks
        } catch (error) {
            log.error('Failed to get all chapter links', error)
            throw error
        }
    },
    
    getChapterLink: async () => {
        log.debug('Retrieving chapter image link')
        
        try {
            const imgSrc = await (await driver.page.$('#page .img-fluid')).getAttribute('src')
            log.debug('Found chapter image', { src: imgSrc })
            return imgSrc
        } catch (error) {
            log.error('Failed to get chapter image link', error)
            throw error
        }
    },
   
    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})