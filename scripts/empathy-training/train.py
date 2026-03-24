#!/usr/bin/env python3
"""
Phase 3: Fine-Tuning Pipeline — ELLIE-990

Fine-tunes distilbert-base-uncased on empathy classification (3 labels).
Exports to ONNX for use with @xenova/transformers in Bun.

Requirements:
  pip install torch transformers datasets onnx onnxruntime optimum

Usage:
  python3 scripts/empathy-training/train.py
  python3 scripts/empathy-training/train.py --epochs 5 --lr 2e-5
"""

import argparse
import json
import os
import sys

def parse_args():
    parser = argparse.ArgumentParser(description="Fine-tune empathy classifier")
    parser.add_argument("--epochs", type=int, default=3, help="Training epochs")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate")
    parser.add_argument("--batch-size", type=int, default=16, help="Batch size")
    parser.add_argument("--model", type=str, default="distilbert-base-uncased", help="Base model")
    parser.add_argument("--data-dir", type=str, default=None, help="Data directory")
    parser.add_argument("--output-dir", type=str, default=None, help="Output directory")
    parser.add_argument("--skip-onnx", action="store_true", help="Skip ONNX export")
    return parser.parse_args()


def main():
    args = parse_args()

    # Resolve paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.join(script_dir, "..", "..")
    data_dir = args.data_dir or os.path.join(project_root, "data", "empathy-training")
    output_dir = args.output_dir or os.path.join(data_dir, "model")

    # Check data exists
    train_file = os.path.join(data_dir, "train.jsonl")
    val_file = os.path.join(data_dir, "val.jsonl")

    if not os.path.exists(train_file):
        print(f"Error: {train_file} not found. Run Phase 1 + 2 first.")
        sys.exit(1)

    print(f"\nPhase 3: Fine-Tuning Pipeline")
    print(f"  Model: {args.model}")
    print(f"  Epochs: {args.epochs}")
    print(f"  LR: {args.lr}")
    print(f"  Batch: {args.batch_size}")
    print(f"  Data: {data_dir}")
    print(f"  Output: {output_dir}\n")

    try:
        import torch
        from transformers import (
            AutoTokenizer,
            AutoModelForSequenceClassification,
            TrainingArguments,
            Trainer,
        )
        from datasets import Dataset
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Install: pip install torch transformers datasets")
        sys.exit(1)

    # ── Load data ─────────────────────────────────────────────

    def load_jsonl(path):
        examples = []
        with open(path) as f:
            for line in f:
                examples.append(json.loads(line.strip()))
        return examples

    train_data = load_jsonl(train_file)
    val_data = load_jsonl(val_file)

    print(f"Loaded {len(train_data)} train, {len(val_data)} val examples")

    train_dataset = Dataset.from_list(train_data)
    val_dataset = Dataset.from_list(val_data)

    # ── Tokenize ──────────────────────────────────────────────

    tokenizer = AutoTokenizer.from_pretrained(args.model)

    def tokenize(batch):
        return tokenizer(batch["text"], truncation=True, padding="max_length", max_length=128)

    train_dataset = train_dataset.map(tokenize, batched=True)
    val_dataset = val_dataset.map(tokenize, batched=True)

    # ── Model ─────────────────────────────────────────────────

    id2label = {0: "LOW", 1: "MODERATE", 2: "HIGH"}
    label2id = {"LOW": 0, "MODERATE": 1, "HIGH": 2}

    model = AutoModelForSequenceClassification.from_pretrained(
        args.model,
        num_labels=3,
        id2label=id2label,
        label2id=label2id,
    )

    # ── Training ──────────────────────────────────────────────

    training_args = TrainingArguments(
        output_dir=output_dir,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        logging_steps=10,
        report_to="none",  # no wandb/tensorboard
        seed=42,
    )

    def compute_metrics(eval_pred):
        import numpy as np
        logits, labels = eval_pred
        predictions = np.argmax(logits, axis=-1)
        accuracy = (predictions == labels).mean()
        return {"accuracy": accuracy}

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        processing_class=tokenizer,
        compute_metrics=compute_metrics,
    )

    print("\nStarting training...\n")
    trainer.train()

    # Save best model
    best_dir = os.path.join(output_dir, "best")
    trainer.save_model(best_dir)
    tokenizer.save_pretrained(best_dir)

    print(f"\nBest model saved to: {best_dir}")

    # ── ONNX Export ───────────────────────────────────────────

    if not args.skip_onnx:
        print("\nExporting to ONNX...")
        try:
            from optimum.onnxruntime import ORTModelForSequenceClassification

            onnx_dir = os.path.join(output_dir, "onnx")
            ort_model = ORTModelForSequenceClassification.from_pretrained(best_dir, export=True)
            ort_model.save_pretrained(onnx_dir)
            tokenizer.save_pretrained(onnx_dir)

            print(f"ONNX model saved to: {onnx_dir}")
            print("Ready for @xenova/transformers")
        except ImportError:
            print("Skipping ONNX export (install: pip install optimum onnxruntime)")
        except Exception as e:
            print(f"ONNX export failed: {e}")
            print("Model is still saved in PyTorch format at: {best_dir}")

    print("\nPhase 3 complete.")


if __name__ == "__main__":
    main()
