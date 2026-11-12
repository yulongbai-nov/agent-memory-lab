#!/usr/bin/env python3
"""Run a synthetic, no-model Graphiti/Kuzu temporal storage experiment.

Requires graphiti-core at ebef986a0b2360211b65751c111cacb4a7d790eb,
Kuzu 0.11.3 and httpx; scenario.json must be adjacent to this script.
All graph relationships, timestamps, and references are manually populated.
"""

import asyncio
import hashlib
import json
import os
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from graphiti_fixture import exact_item, require_pinned_graphiti


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


async def run():
    commit = require_pinned_graphiti()
    os.environ["GRAPHITI_TELEMETRY_ENABLED"] = "false"
    from graphiti_core.driver.driver import GraphProvider
    from graphiti_core.driver.kuzu_driver import KuzuDriver
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

    def date_filter(value, operator):
        return DateFilter(date=timestamp(value), comparison_operator=operator)

    async def search(driver, filters):
        clauses, params = edge_search_filter_query_constructor(
            filters, GraphProvider.KUZU
        )
        query = (
            "MATCH (n:Entity)-[:RELATES_TO]->(e:RelatesToNode_)-[:RELATES_TO]->(m:Entity) WHERE "
            + " AND ".join(clauses)
            + " RETURN e.uuid AS uuid, e.fact AS fact, e.episodes AS episodes, "
            "e.valid_at AS valid_at, e.invalid_at AS invalid_at, e.created_at AS created_at"
        )
        rows, _, _ = await driver.execute_query(query, **params)
        return {"filters": clauses, "rows": rows}

    def as_of_filters(edge_type, time):
        return SearchFilters(
            edge_types=[edge_type],
            valid_at=[[date_filter(time, Op.less_than_equal)]],
            invalid_at=[
                [date_filter(time, Op.greater_than)],
                [DateFilter(comparison_operator=Op.is_null)],
            ],
        )

    data = Path(__file__).with_name("scenario.json").read_bytes()
    scenario = json.loads(data)
    fixture, refs = scenario["fixture"], scenario["references"]
    annotations = {a["id"]: a for a in fixture["annotations"]}
    decision, change = annotations["route-decision"], annotations["route-change"]
    dependency = fixture["dependencies"][0]
    query_specs = {row["id"]: row["request"] for row in scenario["queries"]}
    boundary = query_specs["effective-boundary"]
    dependency_time = query_specs["dependency-time"]
    driver = KuzuDriver(":memory:")

    try:
        for uuid, name in [
            ("route", "Moonbridge lantern route"),
            ("tuesday", "Tuesday"),
            ("wednesday", "Wednesday"),
            ("checklist", "Route checklist"),
        ]:
            await EntityNode(uuid=uuid, name=name, group_id="synthetic").save(driver)

        sources = {}
        for key, edge_id in [
            ("original", decision["id"]),
            ("move", change["id"]),
            ("relation", dependency["id"]),
        ]:
            ref = refs[key]
            item = exact_item(fixture, ref)
            availability = (
                item.get("metadata", {})
                .get("original", {})
                .get("availability", "source-only")
            )
            source = {
                "ref": ref,
                "turnId": item["turnId"],
                "availability": availability,
            }
            sources[key] = source
            await EpisodicNode(
                uuid=key,
                name=key,
                group_id="synthetic",
                source=EpisodeType.text,
                source_description=json.dumps(source, sort_keys=True),
                content=item["text"],
                valid_at=timestamp(item["time"]),
                entity_edges=[edge_id],
            ).save(driver)

        async def save_decision(
            annotation, target, episode, edge_type, edge_id, valid, invalid
        ):
            source_time = timestamp(exact_item(fixture, refs[episode])["time"])
            await EntityEdge(
                uuid=edge_id,
                group_id="synthetic",
                source_node_uuid="route",
                target_node_uuid=target,
                created_at=source_time,
                name=edge_type,
                fact=annotation["text"],
                episodes=[episode],
                valid_at=valid,
                invalid_at=invalid,
                reference_time=source_time,
            ).save(driver)

        effective = timestamp(change["valid_time"])
        await save_decision(
            decision,
            "tuesday",
            "original",
            "DECISION",
            decision["id"],
            timestamp(decision["valid_time"]),
            effective,
        )
        await save_decision(
            change, "wednesday", "move", "DECISION", change["id"], effective, None
        )

        # Simulate the alternative mapping, not a result of model extraction. Both
        # boundaries use the episode reference time to produce a coherent interval.
        simulated = timestamp(exact_item(fixture, refs["move"])["time"])
        await save_decision(
            decision,
            "tuesday",
            "original",
            "SIMULATED",
            "simulated-original",
            timestamp(decision["valid_time"]),
            simulated,
        )
        await save_decision(
            change,
            "wednesday",
            "move",
            "SIMULATED",
            "simulated-change",
            simulated,
            None,
        )

        # Manually map knownAt to created_at for this experiment; Graphiti has not
        # automatically inferred the knowledge time.
        await EntityEdge(
            uuid=dependency["id"],
            group_id="synthetic",
            source_node_uuid="checklist",
            target_node_uuid="route",
            created_at=timestamp(dependency["knownAt"]),
            name="DEPENDENCY",
            fact=dependency["quote"],
            episodes=["relation"],
            valid_at=timestamp(dependency["effectiveAt"]),
        ).save(driver)

        cases = []
        for when, expected, alias in zip(
            boundary["validTimes"],
            scenario["expected"]["effective-boundary"]["facts"],
            ("original", "move"),
            strict=True,
        ):
            result = await search(driver, as_of_filters("DECISION", when))
            assert [row["uuid"] for row in result["rows"]] == [expected]
            episode = await EpisodicNode.get_by_uuid(
                driver, result["rows"][0]["episodes"][0]
            )
            assert expected in episode.entity_edges
            assert json.loads(episode.source_description) == sources[alias]
            result.update(
                {
                    "as_of": when,
                    "episode": {
                        "uuid": episode.uuid,
                        "content": episode.content,
                        "source": json.loads(episode.source_description),
                        "source_time": episode.valid_at,
                        "entity_edges": episode.entity_edges,
                    },
                }
            )
            cases.append(result)

        calibration = await search(
            driver, as_of_filters("SIMULATED", boundary["validTimes"][0])
        )
        assert [row["uuid"] for row in calibration["rows"]] == ["simulated-change"]
        cutoffs = []
        for cutoff, presence in zip(
            dependency_time["knowledgeCutoffs"],
            scenario["expected"]["dependency-time"]["facts"],
            strict=True,
        ):
            filters = SearchFilters(
                edge_types=["DEPENDENCY"],
                valid_at=[[date_filter(dependency_time["asOf"], Op.less_than_equal)]],
                created_at=[[date_filter(cutoff, Op.less_than_equal)]],
            )
            result = await search(driver, filters)
            assert bool(result["rows"]) == (presence == "present")
            result["knowledge_cutoff"] = cutoff
            cutoffs.append(result)

        # Demonstrate that normal Graphiti default creation time is independent of
        # the fixture's knowledge time. No model or automatic extraction is used.
        fresh = EntityNode(
            uuid="fresh", name="Fresh synthetic node", group_id="synthetic"
        )
        await fresh.save(driver)
        loaded = await EntityNode.get_by_uuid(driver, "fresh")
        assert loaded.created_at.replace(tzinfo=timezone.utc) != timestamp(
            dependency["knownAt"]
        )
    finally:
        await driver.close()
    return {
        "graphiti_commit": commit,
        "graphiti_version": version("graphiti-core"),
        "kuzu_version": version("kuzu"),
        "scenario_sha256": hashlib.sha256(data).hexdigest(),
        "boundary": cases,
        "simulated_reference_time_calibration": calibration,
        "dependency_as_of": dependency_time["asOf"],
        "dependency_cutoffs": cutoffs,
        "fresh_node_created_at": loaded.created_at,
        "fixture_knowledge_time": dependency["knownAt"],
        "limitations": [
            "All relationships and timestamps are manually populated",
            "Simulation is not model extraction",
            "Correction semantics are not tested",
            "created_at is manually mapped to knownAt for the dependency test",
            "Kuzu returned timestamps without timezone information; inputs are UTC",
        ],
    }


if __name__ == "__main__":
    print(json.dumps(asyncio.run(run()), default=str, indent=2))
