"""Vercel container entry point. Use asyncio to match the existing API runtime."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("dembrane.main:app", host="0.0.0.0", port=int(os.environ.get("PORT", "80")), loop="asyncio")
