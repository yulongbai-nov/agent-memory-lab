"""Shared inputs for the optional Graphiti temporal comparisons."""

import hashlib
import json
from importlib.metadata import distribution

GRAPHITI_COMMIT = "ebef986a0b2360211b65751c111cacb4a7d790eb"


def require_pinned_graphiti():
    install = distribution("graphiti-core").read_text("direct_url.json")
    commit = (
        json.loads(install).get("vcs_info", {}).get("commit_id") if install else None
    )
    if commit != GRAPHITI_COMMIT:
        raise RuntimeError(
            "Install the Graphiti revision in graphiti-temporal-requirements.txt"
        )
    return commit


def exact_item(fixture, ref):
    """Resolve a full scope/source/item revision, including duplicate item IDs."""
    matches = []
    for batch in fixture["batches"]:
        if batch["scope"] != ref["scope"] or batch["source"] != ref["source"]:
            continue
        for item in batch["items"]:
            record = {"scope": batch["scope"], "source": batch["source"], "item": item}
            canonical = json.dumps(
                record, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            )
            revision = hashlib.sha256(canonical.encode()).hexdigest()
            if item["id"] == ref["id"] and revision == ref["revision"]:
                matches.append(item)
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one matching revision for {ref['id']}")
    return matches[0]
