import { childText, childrenText, childAttribute, childrenAt, Url, CommonModifiers } from "../utils.js"
import log from "../log.js"

const name = 'mangaworld'
const ENDPOINT_URL = 'https://mangaworld.cx'
const CDN_ENDPOINT_URL = 'https://cdn.mangaworld.cx'

export default (driver) => ({
    ...driver,
    name,

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

    getSearchEntryLink: async (entry) =>
        await childAttribute(entry, 'a.thumb', 'href'),

    getEntryField: async (key) => {
        const entry = await driver.page.$('.comic-info')

        const getFieldText = async (idx) => {
            const divs = await entry.$$('.meta-data > .col-12')
            if (!divs[idx]) return

            const el = await divs[idx].$(':nth-child(2)')
            if (!el) return

            return await el.textContent()
        }

        const keys = {
            banner: async () => ({ full_size: await childAttribute(entry, 'div > img', 'src') }),
            title: async () => await childText(entry, '.name'),
            alternative_titles: async () => await entry.$eval('.meta-data > .col-12', el => {
                const clone = el.cloneNode(true)
                clone.querySelector('span').remove()
                return clone.textContent.trim().split(', ')
            }),
            genres: async () => await childrenText(entry, '.badge'),
            author: async () => await getFieldText(2),
            artist: async () => await getFieldText(3),
            type: async () => await getFieldText(4),
            status: async () => await getFieldText(5),
            views: async () => await getFieldText(6),
            year: async () => await getFieldText(7),
            n_volumes: async () => await getFieldText(8),
            n_chaps: async () => await getFieldText(9),
            plot: async () => await childText('.comic-description > div[id]', driver.page)
        }

        const getEntry = keys?.[key]
        if (!getEntry) return

        try {
            log.debug('getting key', { key })
            return await getEntry()
        } catch (err) {
            await driver.page.screenshot({ path: 'downloads/out.png', fullPage: true })
            log.error(`Can't access ${ key } for connector ${ name }`, err, { key, name })
        }
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