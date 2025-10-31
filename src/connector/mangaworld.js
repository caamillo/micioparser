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
            const volumeContainers = await driver.page.$$('.volume-element')
            log.debug('Found volume containers', { count: volumeContainers.length })
        
            const volumes = []
            
            for (let volIdx = 0; volIdx < volumeContainers.length; volIdx++) {
                const container = volumeContainers[volIdx]
                const anchors = await container.$$('a.chap')
                
                const chapters = await Promise.all(
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
                
                const validChapters = chapters.filter(ch => ch !== null)
                
                if (validChapters.length > 0)
                    volumes.push({ chapters: validChapters.reverse() }) // ASC
            }
            
            log.success('Retrieved volumes and chapters', { 
                volumes: volumes.length,
                totalChapters: volumes.reduce((sum, v) => sum + v.chapters.length, 0)
            })

            return volumes.reverse().map((vol, i) => ({ ...vol, volume: i + 1 })) // ASC
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
        try {
            await driver.page.waitForSelector('.page.custom-select', { 
                timeout: 5000,
                state: 'attached'
            })

            const currentIdx = await driver.page.$eval('.page.custom-select', el => el.value)
            
            const pageText = await driver.page.$eval(
                `option[value="${currentIdx}"]`, 
                el => el.innerText
            )

            // Parse the total pages
            const match = pageText.match(/\d+\/(\d+)/)
            if (match) {
                const totalPages = parseInt(match[1])
                log.debug('Found page count from selector', { 
                    currentIdx, 
                    pageText, 
                    totalPages 
                })
                return totalPages
            }

            log.warn('Could not parse page count from text', { pageText })
            return null
        } catch (error) {
            log.error('Failed to get page count', error)
            return null
        }
    },

    getPage: async () => {
        try {
            await driver.page.waitForSelector('#page img.img-fluid', { 
                timeout: 10000,
                state: 'visible'
            })
            
            const img = await driver.page.$('#page img.img-fluid')
            
            if (img) {
                log.debug('Found page image')
                return img
            }

            log.warn('Page image not found')
            return null
        } catch (error) {
            log.error('Failed to get page image', error)
            return null
        }
    },

    getNextPage: async () => {
        try {
            const currentIdx = await driver.page.$eval('.page.custom-select', el => el.value)
            const nextIdx = parseInt(currentIdx) + 1

            // Check if there's a next option
            const nextOption = await driver.page.$(`option[value="${nextIdx}"]`)
            if (!nextOption) {
                log.debug('No more pages available', { currentIdx })
                return false
            }

            // Change the select value to next page
            await driver.page.selectOption('.page.custom-select', String(nextIdx))
            
            await driver.page.waitForTimeout(1500)
            
            await driver.page.waitForLoadState('networkidle', { timeout: 5000 })

            log.debug('Navigated to next page', { from: currentIdx, to: nextIdx })
            return true

        } catch (error) {
            log.error('Failed to navigate to next page', error)
            return false
        }
    },
   
    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})