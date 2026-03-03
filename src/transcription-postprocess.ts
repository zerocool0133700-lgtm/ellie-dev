/**
 * STT Post-Processing — ELLIE-410
 *
 * Applies regex substitutions to raw Whisper transcription output to fix
 * known misrecognitions (e.g. "L.E." → "Ellie", "L.E.O.S." → "Ellie OS").
 *
 * Patterns are loaded from config/stt-corrections.json so new entries can
 * be added without code changes. Longer patterns first (ordering in the JSON
 * file is the authoritative order).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { log } from './logger.ts'

const logger = log.child('stt-postprocess')

interface Correction {
  pattern: string
  replacement: string
}

interface CorrectionsConfig {
  corrections: Correction[]
}

type CompiledCorrection = { re: RegExp; replacement: string }

let compiled: CompiledCorrection[] | null = null

function loadCorrections(): CompiledCorrection[] {
  if (compiled) return compiled

  try {
    const configPath = join(import.meta.dir, '..', 'config', 'stt-corrections.json')
    const raw = readFileSync(configPath, 'utf8')
    const config = JSON.parse(raw) as CorrectionsConfig
    compiled = (config.corrections ?? []).map(c => ({
      re: new RegExp(c.pattern, 'gi'),
      replacement: c.replacement,
    }))
    logger.info(`Loaded ${compiled.length} STT corrections`)
  } catch (err) {
    logger.warn('Failed to load stt-corrections.json — skipping post-processing', err)
    compiled = []
  }

  return compiled
}

/**
 * Apply configured STT corrections to a raw transcription string.
 * Returns the input unchanged if config cannot be loaded.
 */
export function applyTranscriptionCorrections(text: string): string {
  if (!text) return text

  const corrections = loadCorrections()
  let result = text
  for (const { re, replacement } of corrections) {
    // Reset lastIndex between calls (RegExp with 'g' flag is stateful)
    re.lastIndex = 0
    result = result.replace(re, replacement)
  }
  return result
}
