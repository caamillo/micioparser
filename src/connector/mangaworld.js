import { childText, childrenText, childAttribute, Url } from "../utils.js"
import log from "../log.js"

const ENDPOINT_URL = 'https://mangaworld.cx'
const CDN_ENDPOINT_URL = 'https://cdn.mangaworld.cx'

export default (driver) => ({
    ...driver,
    name: 'mangaworld',

    getPages: async() => {
        let pages = await driver.page.$('.page-item.last > a.page-link')
        if (!pages) return
        pages = await pages.textContent()
        if (!pages.length) return
        if (!isNaN(pages)) return parseInt(pages)
        return
    },

    getSearchResults: async() => {
        const entries = await driver.page.$$('.comics-grid > .entry')
        return entries
    },

    getSearchEntry: async(key, entry) => {
        const keys = {
            link: async () => await childAttribute(entry, 'a.thumb', 'href'),
            banner: async () => await childAttribute(entry, 'a.thumb > img', 'src'),
            title: async () => await childText(entry, '.manga-title'),
            type: async () => await childText(entry, '.genre > a'),
            author: async () => await childText(entry, '.author > a'),
            artist: async () => await childText(entry, '.artist > a'),
            genres: async () => await childrenText(entry, '.genres > a'),
            short_plot: async () => await entry.$eval('.story', el => {
                const clone = el.cloneNode(true)
                clone.querySelector('span').remove()
                return clone.textContent.trim()
            })
        }
        const getEntry = keys?.[key]
        if (!getEntry) return
        return await getEntry()
    },

    getSearchUrl(title) {
        return new Url(ENDPOINT_URL, ["archive"], "", {
            keyword: title,
            page: 1
        })
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
           
            return validLinks.reverse() // ASC (0 -> 9)
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

    getPageCount: async () => {
        return null
    },

    getPage: async () => {
        try {
            await driver.page.waitForSelector('img', { timeout: 5000 })
            return await driver.page.$('img')
        } catch (error) {
            log.debug('Image not found', error)
            return null
        }
    },
   
    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})