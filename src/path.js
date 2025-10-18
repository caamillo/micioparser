import path from 'path'
import fs from 'fs/promises'
import log from './log.js'

/**
 * Parses and resolves output path patterns with variable substitution
 * Supported variables: $vol, $chap, $page, $ext
 * 
 * Examples:
 * - "output/vol-$vol/chap-$chap/page-$page.$ext"
 * - "downloads/$vol-$chap-$page.$ext"
 * - "manga/volume_$vol/chapter_$chap_page_$page.$ext"
 */

const DEFAULT_PATTERN = 'output/chapter_$chap/page_$page.$ext'
const DEFAULT_EXTENSION = 'png'

export class Path {
    constructor(pattern = DEFAULT_PATTERN, defaultExt = DEFAULT_EXTENSION) {
        this.pattern = pattern || DEFAULT_PATTERN
        this.defaultExt = defaultExt
        this.createdDirs = new Set()
    }

    /**
     * Parse and resolve a path pattern with given variables
     * @param {Object} vars - Variables to substitute
     * @param {string|number} vars.vol - Volume number
     * @param {string|number} vars.chap - Chapter number
     * @param {string|number} vars.page - Page number
     * @param {string} vars.ext - File extension (optional, uses default if not provided)
     * @returns {string} Resolved file path
     */
    resolve(vars = {}) {
        const {
            vol = '00',
            chap = '00',
            page = '00',
            ext = this.defaultExt
        } = vars

        let resolved = this.pattern

        // Substitute variables
        resolved = resolved.replace(/\$vol/g, this._pad(vol))
        resolved = resolved.replace(/\$chap/g, this._pad(chap))
        resolved = resolved.replace(/\$page/g, this._pad(page))
        resolved = resolved.replace(/\$ext/g, ext.replace(/^\./, '')) // Remove leading dot if present

        // Normalize path separators
        resolved = path.normalize(resolved)

        log.debug('Resolved path pattern', {
            pattern: this.pattern,
            variables: vars,
            resolved
        })

        return resolved
    }

    /**
     * Ensure the directory exists for the given path
     * @param {string} filePath - Full file path
     */
    async ensureDir(filePath) {
        const dir = path.dirname(filePath)

        // Skip if we already created this directory
        if (this.createdDirs.has(dir)) {
            return dir
        }

        try {
            await fs.mkdir(dir, { recursive: true })
            this.createdDirs.add(dir)
            log.debug('Created directory', { dir })
        } catch (error) {
            log.error('Failed to create directory', error, { dir })
            throw error
        }

        return dir
    }

    /**
     * Resolve path and ensure directory exists
     * @param {Object} vars - Variables to substitute
     * @returns {Promise<string>} Resolved file path
     */
    async resolveAndEnsure(vars = {}) {
        const resolved = this.resolve(vars)
        await this.ensureDir(resolved)
        return resolved
    }

    // Pad numbers to 2 digits by default
    _pad(value, length = 2) {
        const str = String(value)
        return str.padStart(length, '0')
    }

    /**
     * Validate the pattern for correctness
     * @returns {Object} Validation result with isValid and errors
     */
    validate() {
        const errors = []
        const warnings = []

        // Check for invalid variable names
        const invalidVars = this.pattern.match(/\$[a-zA-Z_]+/g)
        if (invalidVars) {
            const validVars = ['$vol', '$chap', '$page', '$ext']
            const invalid = invalidVars.filter(v => !validVars.includes(v))
            if (invalid.length > 0) {
                errors.push(`Invalid variables found: ${invalid.join(', ')}. Valid: ${validVars.join(', ')}`)
            }
        }

        // Check if extension is present
        if (!this.pattern.includes('$ext') && !this.pattern.match(/\.[a-zA-Z0-9]+$/)) {
            warnings.push('Pattern does not include $ext or a static extension')
        }

        // Check for required directory separators
        if (!this.pattern.includes('/') && !this.pattern.includes('\\')) {
            warnings.push('Pattern does not include directory separators, all files will be in current directory')
        }

        return {
            isValid: errors.length === 0,
            errors,
            warnings
        }
    }

    /**
     * Extract variables from an existing path that matches the pattern
     * @param {string} filePath - Path to extract variables from
     * @returns {Object|null} Extracted variables or null if no match
     */
    extract(filePath) {
        // Convert pattern to regex
        let regex = this.pattern
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape regex special chars
            .replace(/\\\$vol/g, '(?<vol>\\d+)')
            .replace(/\\\$chap/g, '(?<chap>\\d+)')
            .replace(/\\\$page/g, '(?<page>\\d+)')
            .replace(/\\\$ext/g, '(?<ext>[a-zA-Z0-9]+)')

        const match = filePath.match(new RegExp(regex))
        
        if (!match || !match.groups) {
            return null
        }

        return {
            vol: match.groups.vol,
            chap: match.groups.chap,
            page: match.groups.page,
            ext: match.groups.ext
        }
    }

    /**
     * Get the directory path for a given set of variables (without filename)
     * @param {Object} vars - Variables to substitute
     * @returns {string} Directory path
     */
    getDir(vars = {}) {
        const fullPath = this.resolve(vars)
        return path.dirname(fullPath)
    }

    /**
     * Get the filename for a given set of variables (without directory)
     * @param {Object} vars - Variables to substitute
     * @returns {string} Filename
     */
    getFilename(vars = {}) {
        const fullPath = this.resolve(vars)
        return path.basename(fullPath)
    }

    // Clear the cached created directories
    clearCache() {
        this.createdDirs.clear()
        log.debug('Cleared directory cache')
    }
}
export function createPath(pattern, defaultExt = DEFAULT_EXTENSION) {
    const parser = new Path(pattern, defaultExt)
    const validation = parser.validate()

    if (!validation.isValid) {
        log.error('Invalid path pattern', new Error(validation.errors.join('; ')), { pattern })
        throw new Error(`Invalid path pattern: ${validation.errors.join('; ')}`)
    }

    if (validation.warnings.length > 0) {
        validation.warnings.forEach(warning => {
            log.warn(`Path pattern: ${warning}`, { pattern })
        })
    }

    log.info('Created path parser', { pattern, defaultExt })
    return parser
}

/**
 * Parse options and create appropriate Path
 * @param {Object} options - Options object
 * @param {string} options.outputPath - Output path pattern
 * @param {string} options.outputExt - Default extension
 * @returns {Path}
 */
export function parseOutputOptions(options = {}) {
    const pattern = options.outputPath || DEFAULT_PATTERN
    const ext = options.outputExt || DEFAULT_EXTENSION

    return createPath(pattern, ext)
}

export default Path