#!/usr/bin/env python3
"""Synthetic bounded Graphiti/FalkorDBLite temporal experiment; no model.

Install Graphiti at the pinned commit with its falkordblite extra, Redis < 9,
and httpx. Place this script beside run-graphiti-temporal.py and scenario.json.
The embedded process and data are disposable. See limitations in the report.
"""

import asyncio
import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from graphiti_fixture import exact_item, require_pinned_graphiti

HERE = Path(__file__).resolve().parent
GROUP = "moonbridge_synthetic_falkor"
LIMIT = 2


def utc(value):
    if not isinstance(value, str) or not re.fullmatch(
        r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)", value
    ):
        raise ValueError(f"Unknown or malformed UTC time: {value!r}")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


async def run():
    commit = require_pinned_graphiti()
    os.environ["GRAPHITI_TELEMETRY_ENABLED"] = "false"

    import psutil
    from graphiti_core.driver.driver import GraphProvider
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.edges import EntityEdge
    from graphiti_core.nodes import EntityNode, EpisodeType, EpisodicNode
    from graphiti_core.search.search_filters import (
        ComparisonOperator as Op,
    )
    from graphiti_core.search.search_filters import (
        DateFilter,
        SearchFilters,
        edge_search_filter_query_constructor,
    )
    from redislite.async_falkordb_client import AsyncFalkorDB

    data = (HERE / "scenario.json").read_bytes()
    scenario = json.loads(data)
    fixture, refs = scenario["fixture"], scenario["references"]
    annotations = {a["id"]: a for a in fixture["annotations"]}
    decisions = [annotations["route-decision"], annotations["route-change"]]
    times = next(
        q["request"]["validTimes"]
        for q in scenario["queries"]
        if q["id"] == "effective-boundary"
    )
    expected = scenario["expected"]["effective-boundary"]["facts"]
    source_records = {}
    original_tempdir = tempfile.tempdir
    client = None
    with tempfile.TemporaryDirectory(prefix="graphiti-falkor-") as directory:
        # redislite creates its Unix socket and its configuration under tempfile.
        tempfile.tempdir = directory
        try:
            client = AsyncFalkorDB(dbfilename=str(Path(directory) / "data.db"))
            pid = client.client._sync_client.pid
            driver = FalkorDriver(falkor_db=client, database="moonbridge_synthetic")
            if driver._init_task:
                await driver._init_task
            for uuid, name in [
                ("route", "Moonbridge route"),
                ("tuesday", "Tuesday"),
                ("wednesday", "Wednesday"),
            ]:
                await EntityNode(uuid=uuid, name=name, group_id=GROUP).save(driver)
            for index, (alias, target) in enumerate(
                [("original", "tuesday"), ("move", "wednesday")]
            ):
                annotation = decisions[index]
                item, ref = exact_item(fixture, refs[alias]), refs[alias]
                source = {
                    "ref": ref,
                    "turnId": item["turnId"],
                    "availability": item.get("metadata", {})
                    .get("original", {})
                    .get("availability", "source-only"),
                }
                source_records[alias] = (item, source, annotation["id"])
                await EpisodicNode(
                    uuid=alias,
                    name=alias,
                    group_id=GROUP,
                    source=EpisodeType.text,
                    source_description=json.dumps(source, sort_keys=True),
                    content=item["text"],
                    valid_at=utc(item["time"]),
                    entity_edges=[annotation["id"]],
                ).save(driver)
                await EntityEdge(
                    uuid=annotation["id"],
                    group_id=GROUP,
                    source_node_uuid="route",
                    target_node_uuid=target,
                    name="DECISION",
                    fact=annotation["text"],
                    created_at=utc(item["time"]),
                    valid_at=utc(annotation["valid_time"]),
                    invalid_at=utc(decisions[1]["valid_time"]) if index == 0 else None,
                    episodes=[alias],
                    reference_time=utc(item["time"]),
                ).save(driver)

            base = (
                "MATCH (n:Entity)-[e:RELATES_TO]->(m:Entity) "
                "WHERE e.group_id = $group_id "
            )
            fields = (
                "e.uuid AS uuid, e.name AS name, n.uuid AS source, m.uuid AS target, e.group_id AS group_id, "
                "e.valid_at AS valid_at, e.invalid_at AS invalid_at, e.episodes AS episodes"
            )

            async def read_partition(limit):
                # No temporal predicate. The extra row detects overflow.
                result, _, _ = await driver.execute_query(
                    base + "RETURN " + fields + " LIMIT $bound",
                    group_id=GROUP,
                    bound=limit + 1,
                )
                if len(result) > limit:
                    raise OverflowError("Synthetic partition exceeded validation bound")
                return result

            rows = await read_partition(LIMIT)
            try:
                await read_partition(LIMIT - 1)
            except OverflowError:
                overflow_rejected = True
            else:
                raise AssertionError("Candidate truncation was not rejected")
            mapping = {
                d["id"]: (alias, target)
                for d, (alias, target) in zip(
                    decisions,
                    [("original", "tuesday"), ("move", "wednesday")],
                    strict=True,
                )
            }
            if len(rows) != LIMIT or {r["uuid"] for r in rows} != set(mapping):
                raise ValueError("Unknown, duplicate, or missing synthetic records")
            intervals = []
            for row in rows:
                alias, target = mapping[row["uuid"]]
                if (
                    row["group_id"],
                    row["name"],
                    row["source"],
                    row["target"],
                    row["episodes"],
                ) != (GROUP, "DECISION", "route", target, [alias]):
                    raise ValueError("Unexpected relation identity")
                start = utc(row["valid_at"])
                end = None if row["invalid_at"] is None else utc(row["invalid_at"])
                if end is not None and end <= start:
                    raise ValueError("Invalid temporal interval")
                intervals.append((row, start, end))

            async def native_window(instant):
                filters = SearchFilters(
                    edge_types=["DECISION"],
                    valid_at=[
                        [
                            DateFilter(
                                date=instant, comparison_operator=Op.less_than_equal
                            )
                        ]
                    ],
                    invalid_at=[
                        [DateFilter(date=instant, comparison_operator=Op.greater_than)],
                        [DateFilter(comparison_operator=Op.is_null)],
                    ],
                )
                clauses, params = edge_search_filter_query_constructor(
                    filters, GraphProvider.FALKORDB
                )
                native, _, _ = await driver.execute_query(
                    base
                    + "AND "
                    + " AND ".join(clauses)
                    + " RETURN "
                    + fields
                    + " LIMIT $bound",
                    group_id=GROUP,
                    bound=LIMIT + 1,
                    **params,
                )
                if len(native) > LIMIT:
                    raise ValueError("Native result exceeded validation bound")
                return native

            cases = []
            for when, want in zip(times, expected, strict=True):
                instant = utc(when)
                native = await native_window(instant)
                projection, _, _ = await driver.execute_query(
                    base + "RETURN e.uuid AS uuid, "
                    "e.valid_at <= $valid_at_0 AS valid_test LIMIT $bound",
                    group_id=GROUP,
                    valid_at_0=instant,
                    bound=LIMIT + 1,
                )
                if len(projection) > LIMIT:
                    raise ValueError("Projection exceeded validation bound")
                selected = [
                    row
                    for row, start, end in intervals
                    if start <= instant and (end is None or instant < end)
                ]
                if [r["uuid"] for r in selected] != [want]:
                    raise AssertionError(
                        "Independent bounded temporal result differs from fixture"
                    )
                alias = mapping[selected[0]["uuid"]][0]
                ep = await EpisodicNode.get_by_uuid(driver, alias)
                item, source, edge_id = source_records[alias]
                if (
                    ep.uuid != alias
                    or ep.group_id != GROUP
                    or ep.content != item["text"]
                    or ep.valid_at != utc(item["time"])
                    or ep.entity_edges != [edge_id]
                    or json.loads(ep.source_description) != source
                ):
                    raise ValueError(
                        "Selected episode did not match exact fixture identity"
                    )
                cases.append(
                    {
                        "as_of": when,
                        "native_rows": native,
                        "projection": projection,
                        "independent_rows": selected,
                        "episode": {
                            "uuid": ep.uuid,
                            "content": ep.content,
                            "source": source,
                            "source_time": ep.valid_at,
                        },
                    }
                )
            # Toggle only the range index in this disposable graph. Keep the
            # rows, query, parameters and remaining indexes fixed.
            first_instant = utc(times[0])
            await driver.execute_query(
                "DROP INDEX FOR ()-[e:RELATES_TO]-() ON (e.valid_at)"
            )
            try:
                unindexed = await native_window(first_instant)
            finally:
                await driver.execute_query(
                    "CREATE INDEX FOR ()-[e:RELATES_TO]-() ON (e.valid_at)"
                )
            reindexed = await native_window(first_instant)
            index_control = {
                "as_of": times[0],
                "indexed": sorted(row["uuid"] for row in cases[0]["native_rows"]),
                "without_valid_at_index": sorted(row["uuid"] for row in unindexed),
                "valid_at_index_restored": sorted(row["uuid"] for row in reindexed),
            }
        finally:
            try:
                if client is not None:
                    # Private-client workaround for redislite 0.11.0 async close;
                    # normal context exit warned about an unawaited shutdown.
                    try:
                        await client.client._client.shutdown(nosave=True)
                    finally:
                        await client.close()
                    if psutil.pid_exists(pid):
                        raise RuntimeError("Embedded process did not exit")
            finally:
                tempfile.tempdir = original_tempdir
    return {
        "graphiti_commit": commit,
        "graphiti_version": version("graphiti-core"),
        "falkordblite_version": version("falkordblite"),
        "falkordb_version": version("falkordb"),
        "redis_version": version("redis"),
        "scenario_sha256": hashlib.sha256(data).hexdigest(),
        "bounded_partition": {
            "group_id": GROUP,
            "bound": LIMIT,
            "rows": rows,
            "overflow_rejected": overflow_rejected,
        },
        "cases": cases,
        "index_control": index_control,
        "limitations": [
            "No model: relationships and timestamps are manually populated",
            "Independent result is complete only within this bounded synthetic partition",
            "Native filter results are observations, not required platform behavior",
            "Shutdown uses a private redislite API and may require changes in other versions",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run()), default=str, indent=2))
