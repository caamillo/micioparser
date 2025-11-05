import { childText, childrenText, childAttribute, childrenAt, Url, CommonModifiers } from "../utils.js"
import log from "../log.js"

const name = 'mangadex'
const ENDPOINT_URL = 'https://mangadex.org'
const CDN_ENDPOINT_URL = 'https://mangadex.org'

export default (driver) => ({
    ...driver,
    name,

    getPages: async() => {
        const anchorsText = await childrenText(driver.page, '.flex.justify-center.flex-wrap.gap-2.mt-6 > a')
        if (anchorsText.length >= 2) {
            const maybe = anchorsText[anchorsText.length - 2]
            const parsed = parseInt(maybe)
            return Number.isFinite(parsed) && parsed > 0 ? parsed : null
        }
        return
    },

    getSearchResults: async() => {
        const entries = await driver.page.$$('.grid.gap-2.two-col > div')
        return entries
    },

    getSearchEntryLink: async (entry) => {
        const link = await childAttribute(entry, 'a.title', 'href')
        return link.startsWith('http') ? link : (ENDPOINT_URL + link)
    },

    getEntryField: async (key) => {
        const entry = driver.page
        const side_info = await driver.page.$('.flex.gap-6.items-start > .flex.flex-wrap.gap-x-4.gap-y-2.flex')

        const keys = {
            banner: async () => {
                const half_size_el = await entry.$('.layout-container .group.flex.items-start.relative.mb-auto.select-none img')
                await half_size_el.click()
                const full_size_el = await entry.$('img.max-w-full.max-h-full')

                const [ full_size, half_size ] = [
                    full_size_el,
                    half_size_el
                ].map(async (el) => await el.getAttribute('src'))

                return { full_size, half_size }
            },
            title: async () => await childText(entry, '.title > p'),
            alternative_titles: async () => {
                const divs = await side_info.$$(':scope > div')
                if (!divs[9]) return
                
                const links = await divs[9].$$('.flex > a')
                const texts = await Promise.all(links.map(async link => await link.textContent()))
                return texts
            },
            genres: async () => {
                const allGenres = []
                const divs = await side_info.$$(':scope > div')
                for (const idx of [2, 3, 4]) {
                    if (!divs[idx]) continue
                    const links = await divs[idx].$$('.flex > a')
                    const texts = await Promise.all(links.map(async link => await link.textContent()))
                    allGenres.push(...texts)
                }
                return allGenres
            },
            author: async () => {
                const divs = await side_info.$$(':scope > div')
                if (!divs[0]) return

                const links = await divs[0].$$('.flex > a')
                if (!links[0]) return

                return await links[0].textContent()
            },
            artist: async () => {
                const divs = await side_info.$$(':scope > div')
                if (!divs[1]) return

                const links = await divs[1].$$('.flex > a')
                if (!links[0]) return

                return await links[0].textContent()
            },
            type: async () => 'Manga',
            status: async () => (await childText(entry, '.tag.dot.no-wrapper'))?.split(', ')?.[1],
            year: async () => (await childText(entry, '.tag.dot.no-wrapper'))?.split(', ')?.[0]?.split(':')?.[1],
            plot: async () => await childText(entry, '.md-md-container > p')
        }

        const getEntry = keys?.[key]
        if (!getEntry) return

        try {
            log.debug('getting key', { key, name })
            return await getEntry()
        } catch (err) {
            log.error(`Can't access ${ key } for connector ${ name }`, err, { key, name })
        }
    },

    getSearchUrl(title) {
        return new Url(ENDPOINT_URL, ['titles'], '', {
            q: title,
            page: 1
        })
    },

    getAllChapterLinks: async (opts = {}) => {
        log.debug('Retrieving all chapter links')
        const lang_idx = typeof opts.lang_idx === 'number' ? opts.lang_idx : 0
        
        try {
            await driver.page.waitForTimeout(2000)
            
            // Click index button
            try {
                await driver.page.waitForSelector('button.rounded.custom-opacity.relative.md-btn.text-sm > span', { 
                    timeout: 10000,
                    state: 'visible' 
                })
                const idxBtns = await driver.page.$$('button.rounded.custom-opacity.relative.md-btn.text-sm > span')
                
                if (idxBtns && idxBtns.length >= 2) {
                    log.debug('Found index buttons', { count: idxBtns.length })
                    await idxBtns[1].click()
                    await driver.page.waitForTimeout(1000)
                }
            } catch (error) {
                log.warn('Could not find index button', { error: error.message })
            }
            
            // Get volume list
            let volumeLis = []
            try {
                await driver.page.waitForSelector('.md-modal__box.flex-grow', { timeout: 5000 })
                const modal = await driver.page.$('.md-modal__box.flex-grow')
                if (modal) {
                    volumeLis = await modal.$$('ul > li')
                    log.debug('Found volumes in modal', { count: volumeLis.length })
                }
            } catch (error) {
                log.debug('Modal not found')
            }
            
            if (!volumeLis.length) throw new Error('Volume links not found.')
            
            const volumes = []
            
            for (let volIdx = 0; volIdx < volumeLis.length; volIdx++) {
                const vol = volumeLis[volIdx]
                const chapLis = await vol.$$('ul > li')
                const volBtn = await vol.$('button')
                
                if (volBtn) {
                    try {
                        await volBtn.click()
                        await driver.page.waitForTimeout(300)
                    } catch (e) {
                        log.debug('Could not click volume button', { error: e.message })
                    }
                }
                
                const chapters = []
                
                for (const chap of chapLis) {
                    const chapBtn = await chap.$('button')
                    if (!chapBtn) continue
                    
                    try {
                        await chapBtn.click()
                        await driver.page.waitForTimeout(800)
                        const langLis = await chap.$$('ul > li')
                        if (langLis.length === 0) continue
                        
                        const chosen = langLis[lang_idx] || langLis[0]
                        const anchor = await chosen.$('a')
                        
                        if (anchor) {
                            const href = await anchor.getAttribute('href') || ''
                            const absolute = href.startsWith('http') ? href : ENDPOINT_URL + href
                            chapters.push(Url.fromString(absolute))
                        }
                    } catch (e) {
                        log.debug('Error processing chapter', { error: e.message })
                    }
                }
                
                if (chapters.length > 0) {
                    // Remove duplicates
                    const uniqueChapters = [...new Map(chapters.map(link => 
                        [link.render(), link]
                    )).values()]
                    
                    volumes.push({
                        volume: volIdx + 1,
                        chapters: uniqueChapters
                    })
                }
            }
            
            const totalChapters = volumes.reduce((sum, v) => sum + v.chapters.length, 0)
            
            if (totalChapters === 0) {
                log.warn('No chapter links found')
            } else {
                log.success('Retrieved volumes and chapters', { 
                    volumes: volumes.length,
                    totalChapters 
                })
            }
            
            return volumes
        } catch (error) {
            log.error('Failed to get all chapter links', error)
            return []
        }
    },
    getChapterLink: async () => {
        return driver.page.url()
    },

    // Get the total number of pages in the chapter
    getPageCount: async () => {
        try {
            await driver.page.waitForLoadState('networkidle', { timeout: 10e3 })
            
            // Wait for page counter to appear with longer timeout
            await driver.page.waitForSelector('.reader--meta.page', { 
                timeout: 10e3,
                state: 'visible'
            })
            
            await driver.page.waitForTimeout(500)
            
            const pageText = await driver.page.textContent('.reader--meta.page')
            log.debug('Raw page count found', { pageText })
            
            const match = pageText?.match(/\/\s*(\d+)/)
            
            if (match) {
                const count = parseInt(match[1])
                log.debug('Found page count', { count, pageText })
                return count
            }
            
            log.warn('Could not parse page count from text', { pageText })
            return null
        } catch (error) {
            log.warn('Could not determine page count', { 
                error: error.message,
                url: driver.page.url() 
            })
            return null
        }
    },

    getPage: async () => {
        // Wait for image to be visible
        await driver.page.waitForFunction(() => {
            const imgs = document.querySelectorAll('img.img.sp.limit-width.limit-height.mx-auto')
            return Array.from(imgs).some(img => {
                const rect = img.getBoundingClientRect()
                const isVisible = rect.width > 0 && rect.height > 0 && 
                                img.offsetParent !== null &&
                                img.src.startsWith('blob:') && 
                                img.complete
                return isVisible
            })
        }, { timeout: 10e3 })
        
        // Get image element
        const imgHandle = await driver.page.evaluateHandle(() => {
            const imgs = Array.from(document.querySelectorAll('img.img.sp.limit-width.limit-height.mx-auto'))
            return imgs.find(img => {
                const rect = img.getBoundingClientRect()
                return rect.width > 0 && rect.height > 0 && 
                       img.offsetParent !== null &&
                       img.src.startsWith('blob:') &&
                       img.complete
            })
        })
        
        return imgHandle.asElement()
    },

    /**
     * Navigate to next page using UI (Optional fallback if URL incrementation is not working + driver supports it)
     */
    getNextPage: async () => {
        try {
            await driver.page.keyboard.press('ArrowRight')
            await driver.page.waitForTimeout(800)
            
            // Verify we actually moved to a new page
            const newImg = await driver.page.evaluateHandle(() => {
                const imgs = Array.from(document.querySelectorAll('img.img.sp.limit-width.limit-height.mx-auto'))
                return imgs.find(img => {
                    const rect = img.getBoundingClientRect()
                    return rect.width > 0 && rect.height > 0 && 
                           img.offsetParent !== null &&
                           img.src.startsWith('blob:')
                })
            })
            
            return !!newImg
        } catch (error) {
            log.debug('Navigation to next page failed', error)
            return false
        }
    },

    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})