/**
 * BERT-based Empathy Detector — ELLIE-989
 *
 * Upgrades the keyword/VADER heuristic detector with a transformer model
 * for emotion classification. Uses @xenova/transformers (ONNX runtime)
 * for local inference — no API calls, no data leaves the server.
 *
 * Architecture:
 * - Primary: BERT emotion classifier (6 emotions: sadness, joy, love, anger, fear, surprise)
 * - Fallback: Original keyword/VADER detector if model fails to load
 * - Lazy-loaded: Model downloads on first use (~67MB), cached thereafter
 */

import { log } from "./logger.ts";
import {
  detectEmpathyNeeds as detectEmpathyNeedsKeyword,
  extractPrimaryEmotion as extractPrimaryEmotionKeyword,
  formatResponseGuidance,
  type EmpathyDetectionResult,
} from "./empathy-detector.ts";

const logger = log.child("empathy-detector-bert");

// ── Types ────────────────────────────────────────────────────

interface BertEmpathySignals {
  primary_emotion: string;
  primary_confidence: number;
  secondary_emotion: string | null;
  secondary_confidence: number;
  negative_emotion_total: number;
  distress_score: number;
  model_used: "bert" | "keyword";
}

export interface BertEmpathyResult extends EmpathyDetectionResult {
  bert_signals: BertEmpathySignals;
}

// ── Emotion → Empathy Mapping ────────────────────────────────

/** Sentiment labels from the distilbert SST-2 model */
const SENTIMENT_LABELS = {
  NEGATIVE: "NEGATIVE",
  POSITIVE: "POSITIVE",
} as const;

// ── Model Management ─────────────────────────────────────────

let pipeline: any = null;
let modelLoading: Promise<any> | null = null;
let modelFailed = false;

// Fine-tuned model takes priority if deployed; otherwise fall back to public SST-2
const CUSTOM_MODEL_DIR = `${import.meta.dir}/../data/empathy-model`;
const FALLBACK_MODEL_ID = "Xenova/distilbert-base-uncased-finetuned-sst-2-english";
const MODEL_TASK = "text-classification";

// Track which model is loaded for diagnostics
let loadedModelId = "";

async function getClassifier() {
  if (pipeline) return pipeline;
  if (modelFailed) return null;

  if (!modelLoading) {
    modelLoading = (async () => {
      try {
        const transformers = await import("@xenova/transformers");
        const { pipeline: createPipeline, env } = transformers;
        const { existsSync } = await import("fs");
        const { resolve } = await import("path");

        // Try custom fine-tuned model first
        const customAbsPath = resolve(CUSTOM_MODEL_DIR);
        const useCustom = existsSync(`${customAbsPath}/config.json`);

        logger.info(`Loading empathy model: ${useCustom ? "fine-tuned (local)" : "SST-2 (fallback)"}...`);

        if (useCustom) {
          // @xenova/transformers concatenates localModelPath + modelId
          // Set localModelPath to parent, modelId to folder name
          const parentDir = resolve(customAbsPath, "..");
          const folderName = customAbsPath.split("/").pop()!;
          env.localModelPath = parentDir;
          env.allowRemoteModels = false;
          pipeline = await createPipeline(MODEL_TASK, folderName, {
            quantized: false,
          });
        } else {
          pipeline = await createPipeline(MODEL_TASK, FALLBACK_MODEL_ID, {
            quantized: true,
          });
        }
        loadedModelId = useCustom ? "custom-finetuned" : "sst2-fallback";
        logger.info(`Empathy model loaded: ${loadedModelId}`);
        return pipeline;
      } catch (err) {
        modelFailed = true;
        logger.warn("Failed to load BERT model, falling back to keyword detector", {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    })();
  }

  return modelLoading;
}

// ── Core Detection ───────────────────────────────────────────

interface SentimentResult {
  negative_score: number;
  positive_score: number;
}

interface DirectClassificationResult {
  tier: "HIGH" | "MODERATE" | "LOW";
  confidence: number;
  scores: Record<string, number>;
}

/**
 * Run the classifier and return raw results.
 * Handles both SST-2 (POSITIVE/NEGATIVE) and fine-tuned (LOW/MODERATE/HIGH) models.
 */
async function classifyRaw(text: string): Promise<any[] | null> {
  const classifier = await getClassifier();
  if (!classifier) return null;

  try {
    const truncated = text.length > 400 ? text.slice(0, 400) : text;
    const topk = loadedModelId === "custom-finetuned" ? 3 : 2;
    const results = await classifier(truncated, { topk });
    return Array.isArray(results) ? results : null;
  } catch (err) {
    logger.warn("BERT classification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * For fine-tuned model: direct 3-class classification (LOW/MODERATE/HIGH).
 */
function parseDirectClassification(results: any[]): DirectClassificationResult | null {
  const scores: Record<string, number> = {};
  for (const r of results) {
    scores[String(r.label).toUpperCase()] = Number(r.score);
  }

  // Check if this is a fine-tuned model with our labels
  if (scores["LOW"] !== undefined || scores["MODERATE"] !== undefined || scores["HIGH"] !== undefined) {
    const lowScore = scores["LOW"] ?? 0;
    const modScore = scores["MODERATE"] ?? 0;
    const highScore = scores["HIGH"] ?? 0;

    let tier: "HIGH" | "MODERATE" | "LOW";
    let confidence: number;

    if (highScore >= modScore && highScore >= lowScore) {
      tier = "HIGH";
      confidence = highScore;
    } else if (modScore >= lowScore) {
      tier = "MODERATE";
      confidence = modScore;
    } else {
      tier = "LOW";
      confidence = lowScore;
    }

    return { tier, confidence, scores };
  }

  return null; // Not a fine-tuned model
}

/**
 * For SST-2 fallback: extract sentiment scores.
 */
function parseSentiment(results: any[]): SentimentResult | null {
  let negative_score = 0;
  let positive_score = 0;
  for (const r of results) {
    const label = String(r.label).toUpperCase();
    if (label === "NEGATIVE") negative_score = Number(r.score);
    if (label === "POSITIVE") positive_score = Number(r.score);
  }

  if (negative_score === 0 && positive_score === 0) return null;
  return { negative_score, positive_score };
}

/**
 * Compute empathy score from BERT sentiment + keyword emotion signals.
 *
 * Hybrid scoring:
 * - BERT negative sentiment confidence (40%) — "how negative is this?"
 * - Keyword empathy score (30%) — "what specific emotions are present?"
 * - Vulnerability cues from keyword detector (20%) — "is this person asking for help?"
 * - BERT confidence boost when keyword also detects (10%) — agreement bonus
 */
/**
 * Compute empathy from fine-tuned 3-class model (direct LOW/MODERATE/HIGH output).
 */
function computeEmpathyFromDirectClassification(
  direct: DirectClassificationResult,
  keywordResult: EmpathyDetectionResult
): BertEmpathyResult {
  const { tier, confidence, scores } = direct;

  // Empathy score: blend model confidence with keyword signals
  const modelScore = tier === "HIGH" ? 0.8 + confidence * 0.2
    : tier === "MODERATE" ? 0.4 + confidence * 0.2
    : confidence * 0.25;

  const empathy_score = Math.min(
    modelScore * 0.60 +
    keywordResult.empathy_score * 0.25 +
    (keywordResult.signals.vulnerability_cues_present ? 1 : 0) * 0.15,
    1.0
  );

  // Use model's tier directly when confidence is high, otherwise blend with keyword
  const finalTier = confidence > 0.5 ? tier
    : empathy_score > 0.6 ? "HIGH"
    : empathy_score >= 0.3 ? "MODERATE"
    : "LOW";

  let response_guidance: string;
  if (finalTier === "HIGH") {
    response_guidance = `HIGH EMPATHY NEED detected (fine-tuned model: ${(confidence * 100).toFixed(0)}% confidence). Response approach:
- Acknowledge emotion first (e.g., "That sounds really hard")
- Validate experience (e.g., "It makes sense you'd feel that way")
- Match tone (slower, gentler, patient)
- Ask permission before problem-solving
- Offer space (e.g., "I'm here — no rush")`;
  } else if (finalTier === "MODERATE") {
    response_guidance = `MODERATE EMPATHY NEED detected (fine-tuned model: ${(confidence * 100).toFixed(0)}% confidence). Response approach:
- Brief acknowledgment + solution
- Balance validation + action
- Neutral tone`;
  } else {
    response_guidance = `LOW EMPATHY NEED detected (fine-tuned model: ${(confidence * 100).toFixed(0)}% confidence). Response approach:
- Direct problem-solving
- Efficient, task-focused
- Minimal emotional processing`;
  }

  return {
    empathy_score,
    tier: finalTier,
    signals: keywordResult.signals,
    detected_emotions: keywordResult.detected_emotions,
    response_guidance,
    bert_signals: {
      primary_emotion: keywordResult.detected_emotions[0] || finalTier.toLowerCase(),
      primary_confidence: confidence,
      secondary_emotion: null,
      secondary_confidence: 0,
      negative_emotion_total: (scores["HIGH"] ?? 0) + (scores["MODERATE"] ?? 0),
      distress_score: scores["HIGH"] ?? 0,
      model_used: "bert",
    },
  };
}

/**
 * Compute empathy score from BERT sentiment + keyword emotion signals.
 */
function computeEmpathyFromSentiment(
  sentiment: SentimentResult,
  keywordResult: EmpathyDetectionResult
): BertEmpathyResult {
  const negativeScore = sentiment.negative_score;

  // SST-2 scores imperative/task-focused text as negative (trained on movie reviews).
  // If keyword detector says LOW empathy and no emotion keywords found, trust keywords.
  const keywordSaysTask = keywordResult.tier === "LOW" && keywordResult.detected_emotions.length === 0;
  const adjustedNegative = keywordSaysTask ? negativeScore * 0.15 : negativeScore;

  // Agreement bonus: both BERT and keywords detect distress
  const agreement = adjustedNegative > 0.6 && keywordResult.empathy_score > 0.3 ? 1 : 0;

  const empathy_score = Math.min(
    adjustedNegative * 0.40 +
    keywordResult.empathy_score * 0.30 +
    (keywordResult.signals.vulnerability_cues_present ? 1 : 0) * 0.20 +
    agreement * 0.10,
    1.0
  );

  let tier: "HIGH" | "MODERATE" | "LOW";
  let response_guidance: string;

  if (empathy_score > 0.6) {
    tier = "HIGH";
    response_guidance = `HIGH EMPATHY NEED detected (BERT+keyword score: ${empathy_score.toFixed(2)}, negative sentiment: ${(negativeScore * 100).toFixed(0)}%). Response approach:
- Acknowledge emotion first (e.g., "That sounds really hard")
- Validate experience (e.g., "It makes sense you'd feel that way")
- Match tone (slower, gentler, patient)
- Ask permission before problem-solving (e.g., "Want to talk through it, or explore solutions?")
- Offer space (e.g., "I'm here — no rush")`;
  } else if (empathy_score >= 0.3) {
    tier = "MODERATE";
    response_guidance = `MODERATE EMPATHY NEED detected (BERT+keyword score: ${empathy_score.toFixed(2)}, negative sentiment: ${(negativeScore * 100).toFixed(0)}%). Response approach:
- Brief acknowledgment + solution (e.g., "I hear you. Let's see if we can...")
- Balance validation + action
- Neutral tone`;
  } else {
    tier = "LOW";
    response_guidance = `LOW EMPATHY NEED detected (BERT+keyword score: ${empathy_score.toFixed(2)}). Response approach:
- Direct problem-solving
- Efficient, task-focused
- Minimal emotional processing`;
  }

  // Primary emotion from keyword detector (more specific than sentiment)
  const primaryKeywordEmotion = keywordResult.detected_emotions[0] || (negativeScore > 0.6 ? "distress" : "neutral");

  return {
    empathy_score,
    tier,
    signals: keywordResult.signals,
    detected_emotions: keywordResult.detected_emotions,
    response_guidance,
    bert_signals: {
      primary_emotion: primaryKeywordEmotion,
      primary_confidence: negativeScore,
      secondary_emotion: negativeScore > 0.5 ? "negative-sentiment" : null,
      secondary_confidence: sentiment.positive_score,
      negative_emotion_total: negativeScore,
      distress_score: negativeScore * (keywordResult.empathy_score > 0.3 ? 1.2 : 0.8),
      model_used: "bert",
    },
  };
}

// ── Public API ───────────────────────────────────────────────

/**
 * Detect empathy needs using BERT + keyword hybrid approach.
 * Falls back to pure keyword detection if BERT model unavailable.
 */
export async function detectEmpathyNeedsBert(message: string): Promise<BertEmpathyResult> {
  // Always run keyword detector (fast, synchronous, provides fallback signals)
  const keywordResult = detectEmpathyNeedsKeyword(message);

  // Run classifier
  const rawResults = await classifyRaw(message);

  if (!rawResults) {
    // Fallback: wrap keyword result with empty BERT signals
    return {
      ...keywordResult,
      bert_signals: {
        primary_emotion: "unknown",
        primary_confidence: 0,
        secondary_emotion: null,
        secondary_confidence: 0,
        negative_emotion_total: 0,
        distress_score: 0,
        model_used: "keyword",
      },
    };
  }

  // Try direct classification first (fine-tuned model outputs LOW/MODERATE/HIGH)
  const direct = parseDirectClassification(rawResults);
  if (direct) {
    return computeEmpathyFromDirectClassification(direct, keywordResult);
  }

  // Fall back to sentiment-based scoring (SST-2 outputs NEGATIVE/POSITIVE)
  const sentiment = parseSentiment(rawResults);
  if (sentiment) {
    return computeEmpathyFromSentiment(sentiment, keywordResult);
  }

  // Neither worked — pure keyword fallback
  return {
    ...keywordResult,
    bert_signals: {
      primary_emotion: "unknown",
      primary_confidence: 0,
      secondary_emotion: null,
      secondary_confidence: 0,
      negative_emotion_total: 0,
      distress_score: 0,
      model_used: "keyword",
    },
  };
}

/**
 * Extract primary emotion using BERT (with keyword fallback).
 */
export async function extractPrimaryEmotionBert(
  message: string
): Promise<{ emotion: string; intensity: number; source: "bert" | "keyword" } | null> {
  // Try keyword first for specific emotion names
  const keywordResult = extractPrimaryEmotionKeyword(message);

  const rawResults = await classifyRaw(message);

  // Fine-tuned model: use direct classification
  const direct = rawResults ? parseDirectClassification(rawResults) : null;
  if (direct) {
    if (direct.tier === "HIGH" || direct.tier === "MODERATE") {
      return {
        emotion: keywordResult?.emotion || direct.tier.toLowerCase(),
        intensity: direct.confidence,
        source: "bert",
      };
    }
    return keywordResult ? { ...keywordResult, source: "keyword" } : null;
  }

  // SST-2 fallback
  const sentiment = rawResults ? parseSentiment(rawResults) : null;
  if (keywordResult && sentiment && sentiment.negative_score > 0.5) {
    return {
      emotion: keywordResult.emotion,
      intensity: Math.max(keywordResult.intensity, sentiment.negative_score),
      source: "bert",
    };
  }
  if (keywordResult) return { ...keywordResult, source: "keyword" };
  if (sentiment && sentiment.negative_score > 0.7) {
    return { emotion: "distress", intensity: sentiment.negative_score, source: "bert" };
  }

  return null;
}

/**
 * Format BERT-aware response guidance for prompt injection.
 */
export function formatBertResponseGuidance(result: BertEmpathyResult): string {
  const base = formatResponseGuidance(result);

  if (result.bert_signals.model_used === "keyword") {
    return base;
  }

  return `${base}

**BERT sentiment analysis:**
- Primary: ${result.bert_signals.primary_emotion} (${(result.bert_signals.primary_confidence * 100).toFixed(0)}% negative sentiment)
- Negative sentiment: ${(result.bert_signals.negative_emotion_total * 100).toFixed(0)}%
- Distress score: ${(result.bert_signals.distress_score * 100).toFixed(0)}%`;
}

/**
 * Check if the BERT model is loaded and ready.
 */
export function isBertModelReady(): boolean {
  return pipeline !== null && !modelFailed;
}

/**
 * Get loaded model info for diagnostics.
 */
export function getBertModelInfo(): { ready: boolean; modelId: string; failed: boolean } {
  return { ready: isBertModelReady(), modelId: loadedModelId, failed: modelFailed };
}

/**
 * Hot-reload the model (e.g., after deploying a fine-tuned model).
 * Resets state and triggers a fresh load.
 */
export async function reloadBertModel(): Promise<boolean> {
  logger.info("Hot-reloading empathy model...");
  _resetModelState();
  return preloadBertModel();
}

/**
 * Preload the BERT model (call at startup to avoid first-message latency).
 */
export async function preloadBertModel(): Promise<boolean> {
  const classifier = await getClassifier();
  return classifier !== null;
}

/**
 * Reset model state (for testing).
 */
export function _resetModelState(): void {
  pipeline = null;
  modelLoading = null;
  modelFailed = false;
}
