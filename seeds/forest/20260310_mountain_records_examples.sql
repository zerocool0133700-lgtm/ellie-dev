-- ============================================================
-- ELLIE-663: Example mountain_records rows
-- ============================================================
-- Documents expected payload shapes for each record type
-- from the Office Practicum source system.
-- ============================================================

-- Billing record
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'billing',
  'office-practicum',
  'INV-2026-00142',
  '{
    "patient_id": "PAT-1001",
    "patient_name": "Smith, Jordan",
    "encounter_id": "ENC-5521",
    "cpt_codes": ["99213", "90471"],
    "icd10_codes": ["J06.9", "Z23"],
    "total_charge": 285.00,
    "insurance_billed": 228.00,
    "patient_responsibility": 57.00,
    "payer": "Blue Cross Blue Shield",
    "claim_status": "submitted",
    "date_of_service": "2026-03-05"
  }'::jsonb,
  'Jordan Smith — sick visit + immunization, $285 billed to BCBS',
  '2026-03-05T14:30:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

-- Patient visit record
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'visit',
  'office-practicum',
  'ENC-5521',
  '{
    "patient_id": "PAT-1001",
    "patient_name": "Smith, Jordan",
    "patient_dob": "2020-06-15",
    "visit_type": "sick",
    "provider": "Dr. Martinez",
    "chief_complaint": "Fever and cough x 3 days",
    "diagnosis": ["Upper respiratory infection", "Immunization encounter"],
    "vitals": {
      "temp_f": 100.2,
      "weight_lbs": 42,
      "height_in": 43
    },
    "plan": "Supportive care, fluids, follow up if not improving in 5 days. Administered flu vaccine.",
    "follow_up_days": 5
  }'::jsonb,
  'Jordan Smith sick visit — URI + flu vaccine, follow up in 5 days',
  '2026-03-05T14:00:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;

-- Schedule record
INSERT INTO mountain_records (record_type, source_system, external_id, payload, summary, source_timestamp)
VALUES (
  'schedule',
  'office-practicum',
  'APT-2026-03-12-0900',
  '{
    "patient_id": "PAT-1002",
    "patient_name": "Lee, Avery",
    "patient_dob": "2024-01-20",
    "appointment_type": "well-child",
    "provider": "Dr. Martinez",
    "scheduled_start": "2026-03-12T09:00:00",
    "scheduled_end": "2026-03-12T09:30:00",
    "location": "Main Office - Room 3",
    "status": "confirmed",
    "notes": "12-month well child check, immunizations due"
  }'::jsonb,
  'Avery Lee — 12-month well child check, Mar 12 at 9am',
  '2026-03-10T08:00:00Z'
)
ON CONFLICT (source_system, external_id) DO NOTHING;
