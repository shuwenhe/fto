# FTO Encoder

This directory holds the feature-extraction model assets for FTO.

The `neurx` encoder is trained from recall-stage candidate pairs and learns a low-dimensional latent embedding from the handcrafted reranker features.

Training entry:

```text
/app/fto/encoder/train_fto_encoder_neurx.py
```

Ascend 310P3 pipeline entry:

```text
/app/fto/encoder/run_fto_encoder_pipeline.sh
```

Train on Ascend 310P3:

```bash
cd /app/fto
make train-eval-fto-encoder
```

Default artifact:

```text
/app/fto/model_artifacts/fto_encoder_neurx_v1.json
```
