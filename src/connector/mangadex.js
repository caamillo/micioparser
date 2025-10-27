import { childText, childrenText, childAttribute, Url } from "../utils.js"
import log from "../log.js"

const ENDPOINT_URL = 'https://mangadex.org'
const CDN_ENDPOINT_URL = 'https://mangadex.org'

export default (driver) => ({
    ...driver,
    name: 'mangadex',

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

    getSearchEntry: async(key, entry) => {
        const keys = {
            link: async () => {
                const link = await childAttribute(entry, 'a.title', 'href')
                return link.startsWith('http') ? link : (ENDPOINT_URL + link)
            },
            banner: async () => await childAttribute(entry, 'img.rounded.shadow-md.w-full.h-auto', 'src'),
            title: async () => await childText(entry, 'a.title'),
            genres: async () => await childrenText(entry, '.flex.flex-wrap.gap-1.tags-row.tags.self-start > *'),
            short_plot: async () => await childText(entry, '.md-md-container.dense')
        }

        const getEntry = keys?.[key]
        if (!getEntry) return

        return await getEntry()
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
            
            // Find and click the index button
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
                } else {
                    log.debug('Index buttons not found or insufficient count, trying alternative approach')
                }
            } catch (error) {
                log.warn('Could not find index button, trying alternative selectors', { 
                    error: error.message 
                })
            }

            // Get chapter links from modal
            let volumeLis = []
            try {
                await driver.page.waitForSelector('.md-modal__box.flex-grow', { timeout: 5000 })
                const modal = await driver.page.$('.md-modal__box.flex-grow')
                if (modal) {
                    volumeLis = await modal.$$('ul > li')
                    log.debug('Found chapters in modal', { volumes: volumeLis.length })
                }
            } catch (error) {
                log.debug('Modal not found, trying direct chapter links')
            }

            if (!volumeLis.length) throw new Error('Volume links not found.')

            const links = []

            for (const vol of volumeLis) {
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
                            links.push(Url.fromString(absolute))
                        }
                    } catch (e) {
                        log.debug('Error processing chapter', { error: e.message })
                    }
                }
            }

            // Remove duplicates
            const uniqueLinks = [...new Map(links.map(link => 
                [link.render(), link]
            )).values()]

            const validLinks = uniqueLinks.filter(l => l)
            
            if (validLinks.length === 0) {
                log.warn('No chapter links found')
            } else {
                log.success('Retrieved chapter links', { count: validLinks.length })
            }

            return validLinks
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