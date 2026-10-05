"""Compatibility adapter for the S3 operations used by Echo.

Blob credentials stay in the Node service. Object transfers go straight to
private Blob storage using scoped, short-lived URLs.
"""

# Bucket and ACL are accepted for compatibility with existing boto callers.
# All objects use the configured private Blob store.
# ruff: noqa: ARG002

import requests
from botocore.response import StreamingBody

from dembrane.settings import get_settings


class VercelBlobClient:
    def sign(
        self,
        key: str,
        operation: str,
        content_type: str | None = None,
        expires: int = 3600,
        max_bytes: int = 2147483648,
    ) -> str:
        settings = get_settings().vercel_jobs
        response = requests.post(
            f"{settings.url}/api/storage",
            headers={"Authorization": f"Bearer {settings.secret}"},
            json={
                "key": key,
                "operation": operation,
                "contentType": content_type,
                "expires": min(expires, 3600),
                "maxBytes": max_bytes,
            },
            timeout=30,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Storage signing failed ({response.status_code})")
        return response.json()["url"]

    def generate_presigned_url(self, operation: str, *, Params: dict, ExpiresIn: int) -> str:
        return self.sign(
            Params["Key"],
            {"get_object": "get", "put_object": "put"}[operation],
            Params.get("ContentType"),
            ExpiresIn,
        )

    def put_object(
        self,
        *,
        Bucket: str,
        Key: str,
        Body,
        ACL: str = "private",
        ContentType: str = "application/octet-stream",
    ) -> None:
        response = requests.put(
            self.sign(Key, "put", ContentType),
            data=Body,
            headers={"Content-Type": ContentType},
            timeout=300,
        )
        if not response.ok:
            raise RuntimeError(f"Blob upload failed ({response.status_code})")

    def upload_fileobj(self, *, Fileobj, Bucket: str, Key: str, ExtraArgs: dict) -> None:
        self.put_object(
            Bucket=Bucket,
            Key=Key,
            Body=Fileobj,
            ContentType=ExtraArgs.get("ContentType", "application/octet-stream"),
        )

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        response = requests.get(self.sign(Key, "get"), stream=True, timeout=60)
        response.raise_for_status()
        return {"Body": StreamingBody(response.raw, int(response.headers["Content-Length"]))}

    def head_object(self, *, Bucket: str, Key: str) -> dict:
        response = requests.head(self.sign(Key, "head"), timeout=30)
        response.raise_for_status()
        return {"ContentLength": int(response.headers["Content-Length"])}

    def delete_object(self, *, Bucket: str, Key: str) -> None:
        response = requests.delete(self.sign(Key, "delete"), timeout=30)
        response.raise_for_status()
