import { childText, childrenText, childAttribute, Url } from "../utils.js"
import log from "../log.js"

const name = 'mangaworld'
const ENDPOINT_URL = 'https://mangaworld.cx'
const CDN_ENDPOINT_URL = 'https://cdn.mangaworld.cx'

export default (driver) => ({
    ...driver,
    name,

    getPages: async () => {
        let pages = await driver.page.$('.page-item.last > a.page-link')
        if (!pages) return
        pages = await pages.textContent()
        if (!pages.length) return
        if (!isNaN(pages)) return parseInt(pages)
        return
    },

    getSearchResults: async () => {
        const entries = await driver.page.$$('.comics-grid > .entry')
        
        const results = await Promise.all(entries.map(async (entry) => {
            const title = await entry.$eval('a.manga-title', el => el.textContent)
            const link = await entry.$eval('a.manga-title', el => el.href)
            return { title, link }
        }))
        
        return results
    },

    /**
     * Get field from book detail page (must be on detail page)
     */
    getEntryField: async (key, only_keys=false) => {
        const entry = await driver.page.$('.comic-info')
        
        if (!entry) {
            log.warn('Not on book detail page')
            return null
        }

        const getFieldText = async (idx) => {
            const divs = await entry.$$('.meta-data > .col-12')
            if (!divs[idx]) return null

            const el = await divs[idx].$(':nth-child(2)')
            if (!el) return null

            return await el.textContent()
        }

        const keys = {
            banner: async () => {
                const src = await childAttribute(entry, 'div > img', 'src')
                return src ? { full_size: src } : null
            },
            title: async () => await childText(entry, '.name'),
            alternative_titles: async () => {
                try {
                    return await entry.$eval('.meta-data > .col-12', el => {
                        const clone = el.cloneNode(true)
                        const span = clone.querySelector('span')
                        if (span) span.remove()
                        return clone.textContent.trim().split(', ')
                    })
                } catch {
                    return null
                }
            },
            genres: async () => await childrenText(entry, '.badge'),
            author: async () => await getFieldText(2),
            artist: async () => await getFieldText(3),
            type: async () => await getFieldText(4),
            status: async () => await getFieldText(5),
            views: async () => await getFieldText(6),
            year: async () => await getFieldText(7),
            n_volumes: async () => await getFieldText(8),
            n_chaps: async () => await getFieldText(9),
            plot: async () => {
                await driver.page.waitForSelector('.comic-description > :nth-child(2)')
                return await childText(driver.page, '.comic-description > :nth-child(2)')
            }
        }

        if (only_keys) return Object.keys(keys)

        const getEntry = keys?.[key]
        if (!getEntry) return null

        try {
            log.debug('Getting field', { key, name })
            return await getEntry()
        } catch (err) {
            log.error(`Failed to get field ${key}`, err, { key, name })
            return null
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
                    volumes.push({ chapters: validChapters.reverse() })
            }

            log.success('Retrieved volumes and chapters', {
                volumes: volumes.length,
                totalChapters: volumes.reduce((sum, v) => sum + v.chapters.length, 0)
            })

            return volumes.reverse().map((vol, i) => ({ ...vol, volume: i + 1 }))
        } catch (error) {
            log.error('Failed to get all chapter links', error)
            throw error
        }
    },

    getChapterLink: async () => {
        log.debug('Retrieving chapter image link')

        try {
            const img = await driver.page.$('#page .img-fluid')
            if (!img) throw new Error('Image not found')
            
            const imgSrc = await img.getAttribute('src')
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

            const match = pageText.match(/\d+\/(\d+)/)
            if (match) {
                const totalPages = parseInt(match[1])
                log.debug('Found page count', { totalPages, pageText })
                return totalPages
            }

            log.warn('Could not parse page count', { pageText })
            return null
        } catch (error) {
            log.debug('Failed to get page count', { error: error.message })
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

            const nextOption = await driver.page.$(`option[value="${nextIdx}"]`)
            if (!nextOption) {
                log.debug('No more pages', { currentIdx })
                return false
            }

            await driver.page.selectOption('.page.custom-select', String(nextIdx))
            await driver.page.waitForTimeout(1500)
            await driver.page.waitForLoadState('networkidle', { timeout: 5000 })

            log.debug('Navigated to next page', { from: currentIdx, to: nextIdx })
            return true
        } catch (error) {
            log.debug('Failed to navigate to next page', { error: error.message })
            return false
        }
    },

    ENDPOINT_URL,
    CDN_ENDPOINT_URL
})