"""Minimal OpenAI-compatible transcription server for parakeet-tdt-1.1b."""

import tempfile
import torch
import nemo.collections.asr as nemo_asr
from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import JSONResponse
import uvicorn

MODEL_PATH = "/home/joswick/models/parakeet-tdt-1.1b/parakeet-tdt-1.1b.nemo"

app = FastAPI()

# Load model once at startup
print("Loading model...")
model = nemo_asr.models.EncDecRNNTBPEModel.restore_from(MODEL_PATH, map_location="cuda")
model.eval()
model.freeze()
print("Model loaded on GPU.")


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form(default="parakeet-tdt-1.1b"),
    language: str = Form(default="en"),
    response_format: str = Form(default="json"),
):
    """OpenAI-compatible transcription endpoint."""
    suffix = "." + file.filename.rsplit(".", 1)[-1] if "." in file.filename else ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(await file.read())
        tmp.flush()
        # model.transcribe expects a list of file paths
        with torch.amp.autocast("cuda"):
            result = app.state.asr_model.transcribe([tmp.name])

    # result is a list of Hypothesis objects or strings depending on nemo version
    if hasattr(result[0], "text"):
        text = result[0].text
    elif isinstance(result, tuple):
        text = result[0][0] if isinstance(result[0], list) else str(result[0])
    else:
        text = str(result[0])

    if response_format == "text":
        return text
    return JSONResponse({"text": text})


@app.on_event("startup")
async def store_model():
    """Store model in app state to avoid shadowing by the form parameter."""
    app.state.asr_model = model


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
