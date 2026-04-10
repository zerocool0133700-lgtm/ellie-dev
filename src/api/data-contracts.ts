/**
 * Data Contracts API — ELLIE-1532
 *
 * REST endpoints for the contract builder.
 *
 * Endpoints:
 *   POST /api/contracts/create          — create a new contract
 *   GET  /api/contracts/list             — list contracts (optional ?scope_id=)
 *   GET  /api/contracts/get?id=          — get contract by ID
 *   POST /api/contracts/revise           — revise a contract (bumps revision)
 *   GET  /api/contracts/history?id=      — get contract revision history
 *   POST /api/contracts/documents/create — create a document against a contract
 *   GET  /api/contracts/documents/list   — list documents (?contract_id= &scope_id=)
 *   GET  /api/contracts/documents/get?id= — get document by ID
 *   POST /api/contracts/documents/revise — revise a document
 *   GET  /api/contracts/documents/history?id= — get document revision history
 *   POST /api/contracts/refs/add         — add a contract ref
 *   GET  /api/contracts/refs/list?id=    — list contract refs
 *   POST /api/contracts/documents/refs/add  — add a document ref
 *   GET  /api/contracts/documents/refs/list?id= — list document refs
 */

import {
  createContract, getContract, getContractByName, listContracts,
  reviseContract, getContractHistory,
  createDocument, getDocument, listDocuments,
  reviseDocument, getDocumentHistory,
  addContractRef, getContractRefs, getContractDependents,
  addDocumentRef, getDocumentRefs, findDocumentsByRef,
} from '../../../ellie-forest/src/data-contracts'
import type { ApiRequest, ApiResponse } from './types'

// ── Contracts ──────────────────────────────────────────────────

export async function contractCreateEndpoint(req: ApiRequest, res: ApiResponse) {
  const { scope_id, name, schema, anchor_values, description } = req.body as any
  if (!scope_id || !name || !schema) {
    return res.status(400).json({ error: 'scope_id, name, and schema are required' })
  }
  const contract = await createContract({ scope_id, name, schema, anchor_values, description })
  res.json({ success: true, contract })
}

export async function contractGetEndpoint(req: ApiRequest, res: ApiResponse) {
  const id = req.query?.id
  if (!id) return res.status(400).json({ error: 'id query param required' })
  const contract = await getContract(id)
  if (!contract) return res.status(404).json({ error: 'Contract not found' })
  res.json({ success: true, contract })
}

export async function contractListEndpoint(req: ApiRequest, res: ApiResponse) {
  const scopeId = req.query?.scope_id
  const contracts = await listContracts(scopeId || undefined)
  res.json({ success: true, count: contracts.length, contracts })
}

export async function contractReviseEndpoint(req: ApiRequest, res: ApiResponse) {
  const { id, schema, anchor_values, description } = req.body as any
  if (!id || !schema) {
    return res.status(400).json({ error: 'id and schema are required' })
  }
  const contract = await reviseContract(id, { schema, anchor_values, description })
  res.json({ success: true, contract })
}

export async function contractHistoryEndpoint(req: ApiRequest, res: ApiResponse) {
  const id = req.query?.id
  if (!id) return res.status(400).json({ error: 'id query param required' })
  const history = await getContractHistory(id)
  res.json({ success: true, count: history.length, history })
}

// ── Documents ──────────────────────────────────────────────────

export async function documentCreateEndpoint(req: ApiRequest, res: ApiResponse) {
  const { contract_id, scope_id, document, contract_revision } = req.body as any
  if (!contract_id || !scope_id || !document) {
    return res.status(400).json({ error: 'contract_id, scope_id, and document are required' })
  }
  const doc = await createDocument({ contract_id, scope_id, document, contract_revision })
  res.json({ success: true, document: doc })
}

export async function documentGetEndpoint(req: ApiRequest, res: ApiResponse) {
  const id = req.query?.id
  if (!id) return res.status(400).json({ error: 'id query param required' })
  const doc = await getDocument(id)
  if (!doc) return res.status(404).json({ error: 'Document not found' })
  res.json({ success: true, document: doc })
}

export async function documentListEndpoint(req: ApiRequest, res: ApiResponse) {
  const contractId = req.query?.contract_id
  const scopeId = req.query?.scope_id
  const docs = await listDocuments({
    contract_id: contractId || undefined,
    scope_id: scopeId || undefined,
  })
  res.json({ success: true, count: docs.length, documents: docs })
}

export async function documentReviseEndpoint(req: ApiRequest, res: ApiResponse) {
  const { id, document, contract_revision } = req.body as any
  if (!id || !document) {
    return res.status(400).json({ error: 'id and document are required' })
  }
  const doc = await reviseDocument(id, { document, contract_revision })
  res.json({ success: true, document: doc })
}

export async function documentHistoryEndpoint(req: ApiRequest, res: ApiResponse) {
  const id = req.query?.id
  if (!id) return res.status(400).json({ error: 'id query param required' })
  const history = await getDocumentHistory(id)
  res.json({ success: true, count: history.length, history })
}

// ── Contract Refs ──────────────────────────────────────────────

export async function contractRefAddEndpoint(req: ApiRequest, res: ApiResponse) {
  const { contract_id, target_contract_id, target_revision, ref_type, ref_path, description } = req.body as any
  if (!contract_id || !target_contract_id || !ref_type) {
    return res.status(400).json({ error: 'contract_id, target_contract_id, and ref_type are required' })
  }
  const ref = await addContractRef({ contract_id, target_contract_id, target_revision, ref_type, ref_path, description })
  res.json({ success: true, ref })
}

export async function contractRefListEndpoint(req: ApiRequest, res: ApiResponse) {
  const id = req.query?.id
  if (!id) return res.status(400).json({ error: 'id query param required' })
  const refs = await getContractRefs(id)
  res.json({ success: true, count: refs.length, refs })
}

// ── Document Refs ──────────────────────────────────────────────

export async function documentRefAddEndpoint(req: ApiRequest, res: ApiResponse) {
  const { document_id, ref_type, ref_key, ref_value } = req.body as any
  if (!document_id || !ref_type || !ref_key) {
    return res.status(400).json({ error: 'document_id, ref_type, and ref_key are required' })
  }
  const ref = await addDocumentRef({ document_id, ref_type, ref_key, ref_value })
  res.json({ success: true, ref })
}

export async function documentRefListEndpoint(req: ApiRequest, res: ApiResponse) {
  const id = req.query?.id
  if (!id) return res.status(400).json({ error: 'id query param required' })
  const refs = await getDocumentRefs(id)
  res.json({ success: true, count: refs.length, refs })
}
