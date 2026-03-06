import asyncio
import os
from iii_sdk import III

iii = III(
    "ws://localhost:49134",
    worker_name="embedding",
)

model = None


def get_model():
    global model
    if model is None:
        try:
            from sentence_transformers import SentenceTransformer

            model_name = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
            model = SentenceTransformer(model_name)
        except ImportError:
            model = "fallback"
    return model


@iii.function(id="embedding::generate", description="Generate text embeddings")
async def generate_embedding(input):
    text = input.get("text", "")
    batch = input.get("batch")

    m = get_model()

    if m == "fallback":
        if batch:
            return {"embeddings": [_hash_embed(t) for t in batch], "dim": 128}
        return {"embedding": _hash_embed(text), "dim": 128}

    if batch:
        embeddings = m.encode(batch, normalize_embeddings=True)
        return {
            "embeddings": [e.tolist() for e in embeddings],
            "dim": embeddings.shape[1],
        }

    embedding = m.encode([text], normalize_embeddings=True)[0]
    return {"embedding": embedding.tolist(), "dim": len(embedding)}


@iii.function(id="embedding::similarity", description="Compute cosine similarity")
async def compute_similarity(input):
    a = input.get("a", [])
    b = input.get("b", [])

    if len(a) != len(b) or not a:
        return {"similarity": 0.0}

    dot = sum(x * y for x, y in zip(a, b))
    norm_a = sum(x * x for x in a) ** 0.5
    norm_b = sum(x * x for x in b) ** 0.5
    denom = norm_a * norm_b

    return {"similarity": dot / denom if denom > 0 else 0.0}


def _hash_embed(text: str, dim: int = 128) -> list:
    import math

    words = text.lower().split()
    vec = [0.0] * dim
    for word in words:
        h = hash(word) & 0xFFFFFFFF
        for i in range(dim):
            vec[i] += math.sin(h * (i + 1)) / max(len(words), 1)

    norm = sum(v * v for v in vec) ** 0.5
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


async def main():
    print("embedding worker started")
    try:
        await asyncio.Event().wait()
    except KeyboardInterrupt:
        await iii.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
