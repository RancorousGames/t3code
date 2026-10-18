#!/usr/bin/env python3
"""Offline, read-only ChatGPT session grouping experiment.

Uses a captured snapshot in .t3/grouping-lab, registered T3 project names,
workspace path *names* (no source file contents), and user-reviewed labels.
Does not mutate T3 sessions, storage, or the live sidebar.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / ".t3" / "grouping-lab"
# Ignore generated/dependency trees as corpus noise; these are paths, not
# labels/stop-words for titles or projects.
SKIP_DIRS = {
    ".git", "node_modules", "Binaries", "Intermediate", "Saved",
    "DerivedDataCache", ".venv", ".next", ".t3", "dist", "build",
    ".cache", "coverage", "__pycache__", ".idea", ".vscode",
}
MAX_ENTRIES = 24000


def terms(text: str) -> list[str]:
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", text)
    return [word.casefold() for word in re.findall(r"[A-Za-z0-9]{3,}", spaced)]


def names(project: dict) -> list[str]:
    title = project["title"]
    root = project.get("workspaceRoot") or ""
    basename = re.split(r"[/\\]+", root.rstrip("/\\"))[-1]
    return sorted({title, basename})


def project_name_score(title: str, project: dict) -> float:
    candidate = terms(title)
    if not candidate:
        return 0.0
    in_title = set(candidate)
    best = 0.0
    for name in names(project):
        parts = terms(name)
        if not parts:
            continue
        if len(parts) > 1 and any(candidate[i:i+len(parts)] == parts
                                    for i in range(len(candidate)-len(parts)+1)):
            best = max(best, 40.0 + len(parts))
        elif len(parts) == 1 and parts[0] in in_title:
            # Short names like a worktree's 'main' are not evidence that
            # an unrelated multi-word title belongs to that workspace.
            if len(parts[0]) >= 5 or candidate == parts:
                best = max(best, 32.0)
        elif len(parts) > 1 and all(part in in_title for part in parts):
            best = max(best, 28.0)
        elif len(parts) > 1 and any(len(part) >= 5 and part in in_title for part in parts):
            best = max(best, 15.0)
    return best


def workspace_index(projects: list[dict]) -> dict:
    """Read path names only, bounded per project. Never follow symlink folders."""
    index: dict[str, dict[str, int]] = {}
    for project in projects:
        root = Path(project["workspaceRoot"])
        counter: Counter[str] = Counter()
        visited = 0
        if root.is_dir():
            for folder, dirs, files in os.walk(root, followlinks=False):
                dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
                # A directory name should not be counted thousands of times
                # merely because it contains thousands of files.
                relative = Path(folder).relative_to(root)
                if relative.parts:
                    # Count each directory name once, not for every child path.
                    counter.update(set(terms(Path(folder).name)))
                for filename in sorted(files):
                    if visited >= MAX_ENTRIES:
                        break
                    visited += 1
                    counter.update(set(terms(Path(filename).stem)))
                if visited >= MAX_ENTRIES:
                    break
        index[project["id"]] = dict(counter)
    return index


def corpus_scores(title: str, projects: list[dict], index: dict) -> dict[str, float]:
    present = set(terms(title))
    # Names are authoritative. Repo vocabulary is auxiliary and is weighted
    # by how distinctive it is across all registered projects.
    n = len(projects)
    document_frequency: Counter[str] = Counter()
    for vocabulary in index.values():
        document_frequency.update(word for word, occurrences in vocabulary.items()
                                  if occurrences >= 2)
    scores: dict[str, float] = {}
    for project in projects:
        project_id = project["id"]
        score = project_name_score(title, project)
        vocabulary = index.get(project_id, {})
        for token in present:
            count = vocabulary.get(token, 0)
            if count < 2 or len(token) < 4:
                continue
            # The number of independent paths carrying a word is meaningful:
            # one incidental filename is not a reliable project signal.
            idf = math.log(1 + (n + 1) / (1 + document_frequency[token]))
            strength = max(0.0, math.log1p(count) - math.log(10))
            score += min(5.0, strength) * idf * 1.5
        scores[project_id] = round(score, 4)
    return scores


def classify_session(session: dict, projects: list[dict], index: dict) -> dict:
    text = session.get("project") or session.get("title") or ""
    scores = corpus_scores(text, projects, index)
    ranked = sorted(scores.items(), key=lambda pair: (-pair[1], pair[0]))
    if not ranked or ranked[0][1] < 4:
        return {"project": None, "confidence": 0, "scores": ranked[:3]}
    winner, score = ranked[0]
    second = ranked[1][1] if len(ranked) > 1 else 0.0
    # Ambiguity remains unresolved rather than guessed.
    minimum_gap = 3.0 if score < 20 else 5.0
    if score - second < minimum_gap:
        return {"project": None, "confidence": 0, "scores": ranked[:3],
                "ambiguous": True}
    return {"project": winner, "confidence": round(score-second, 2),
            "scores": ranked[:3]}


def discover_clusters(sessions: list[dict], predictions: dict[str, dict],
                      projects: list[dict]) -> dict[str, list[str]]:
    """Fallback unknown clusters: use corpus proper-name evidence.

    We avoid generic shared words even when they are rare (e.g. 'using').
    Prefer names appearing capitalized in some real session title; no
    hardcoded word stoplist.
    """
    project_terms = {term for project in projects for name in names(project)
                     for term in terms(name)}
    frequencies: dict[str, set[str]] = defaultdict(set)
    proper_owners: dict[str, set[str]] = defaultdict(set)
    for session in sessions:
        title = session["title"]
        for match in re.finditer(r"\b[A-Za-z][A-Za-z0-9]{3,}\b", title):
            token = match.group(0)
            normalized = token.casefold()
            if normalized not in project_terms:
                frequencies[normalized].add(session["id"])
            if token[0].isupper() and not token.isupper() and match.start() > 0:
                proper_owners[normalized].add(session['id'])
            if token[0].isupper() and len(token) >= 7 and match.start() == 0:
                proper_owners[normalized].add(session['id'])
    # A token must be observed in >=2 sessions, carry name-like casing
    # somewhere, and cohere into a group of >=2. No "using" or "review".
    return {name: sorted(ids) for name, ids in frequencies.items()
            if len(ids) >= 2 and len(proper_owners[name]) >= 2}


def predict(snapshot: dict, index: dict) -> dict:
    projects = snapshot["projects"]
    sessions = snapshot["sessions"]
    predictions = {session["id"]: classify_session(session, projects, index)
                   for session in sessions}
    clusters = discover_clusters(sessions, predictions, projects)
    by_id = {session['id']: session for session in sessions}
    for name, ids in clusters.items():
        for id in ids:
            # Coherent names repeated in multiple titles are stronger evidence
            # than incidental filename overlap, unless a registered project
            # name explicitly appears in the session title.
            title = by_id[id]['title']
            current = predictions[id]['project']
            registered = next((project for project in projects if project['id'] == current), None)
            if not registered or project_name_score(title, registered) < 20:
                predictions[id] = {**predictions[id], 'project': None,
                                   'confidence': 0, 'customGroup': name}
    # Only exact parent IDs are considered reliable. Nothing in two
    # similarly-named titles proves a spawn relationship.
    relationships = {s["id"]: s.get("parentSessionId") for s in sessions
                     if s.get("parentSessionId")}
    return {
        "snapshotCapturedAt": snapshot["capturedAt"],
        "predictor": "registered project name + discriminative workspace filenames + proper-name clusters",
        "projects": predictions,
        "unknownNameClusters": clusters,
        "parentLinks": relationships,
    }


def create_template(snapshot: dict, path: Path) -> None:
    if path.exists():
        return
    template = {
        "instructions": "Assign project as registered project title/id or null; parent as exact session ID or null. Unlabeled entries must be omitted. This file is user ground truth; model never writes labels.",
        "projectBySessionId": {},
        "customGroupBySessionId": {},
        "forbiddenGroupNames": [],
        "parentBySessionId": {},
    }
    path.write_text(json.dumps(template, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def evaluate(snapshot: dict, predicted: dict, truth: dict) -> dict:
    names_to_id = {key.casefold(): project["id"]
                   for project in snapshot["projects"]
                   for key in (project["title"], project["id"])}
    actual = predicted["projects"]
    project_matches, project_errors, project_ambiguous = 0, [], 0
    for id, expected in truth.get("projectBySessionId", {}).items():
        choices = expected if isinstance(expected, list) else [expected]
        # Multiple acceptable affiliations are not a unique project label.
        # Don't inflate or penalize the classifier for abstaining.
        if len(choices) > 1:
            project_ambiguous += 1
            continue
        if id not in actual:
            project_errors.append({"id": id, "reason": "unknown session"})
            continue
        allowed = [names_to_id.get(option.casefold(), option) if isinstance(option, str)
                   else option for option in choices]
        if actual[id]["project"] in allowed:
            project_matches += 1
        else:
            project_errors.append({"id": id, "expected": allowed,
                                   "predicted": actual[id]["project"]})
    clusters = predicted["unknownNameClusters"]
    custom_matches, custom_errors = 0, []
    for id, expected in truth.get("customGroupBySessionId", {}).items():
        actual_names = [name for name, members in clusters.items() if id in members]
        if expected.casefold() in actual_names:
            custom_matches += 1
        else:
            custom_errors.append({"id": id, "expected": expected, "predicted": actual_names})
    forbidden = [name for name in truth.get("forbiddenGroupNames", [])
                 if name.casefold() in clusters]
    parents = predicted["parentLinks"]
    parent_matches, parent_errors = 0, []
    for id, expected in truth.get("parentBySessionId", {}).items():
        if parents.get(id) == expected:
            parent_matches += 1
        else:
            parent_errors.append({"id": id, "expected": expected,
                                  "predicted": parents.get(id)})
    return {
        "project": {"correct": project_matches,
                    "labeled": len(truth.get("projectBySessionId", {})) - project_ambiguous,
                    "ambiguousUnscored": project_ambiguous,
                    "errors": project_errors},
        "customGroups": {"correct": custom_matches,
                         "labeled": len(truth.get("customGroupBySessionId", {})),
                         "errors": custom_errors, "forbiddenDetected": forbidden},
        "parent": {"correct": parent_matches,
                   "labeled": len(truth.get("parentBySessionId", {})),
                   "errors": parent_errors},
    }


def apply_confirmed_feedback(snapshot: dict, truth: dict) -> dict:
    """Make an annotated fixture without altering the raw captured snapshot.

    User-approved exact session assignments survive generic titles; feedback
    is not a hardcoded term map applied to unrelated sessions.
    """
    valid_projects = {project["id"].casefold(): project["title"]
                      for project in snapshot["projects"]}
    valid_projects.update({project["title"].casefold(): project["title"]
                           for project in snapshot["projects"]})
    valid_ids = {session["id"] for session in snapshot["sessions"]}
    parent_labels = truth.get("parentBySessionId", {})
    annotated = []
    for session in snapshot["sessions"]:
        result = dict(session)
        if session["id"] in truth.get("projectBySessionId", {}):
            choices = truth["projectBySessionId"][session["id"]]
            if not isinstance(choices, list):
                choices = [choices]
            if len(choices) == 1:
                value = choices[0]
                if value is None:
                    result.pop("project", None)
                else:
                    if value.casefold() not in valid_projects:
                        raise ValueError(f"Unknown project ground truth: {value}")
                    result["project"] = valid_projects[value.casefold()]
            else:
                result["projectChoices"] = choices
        if session["id"] in parent_labels:
            parent = parent_labels[session["id"]]
            if parent is not None and (parent not in valid_ids or parent == session["id"]):
                raise ValueError(f"Invalid confirmed parent for {session['id']}")
            result["parentSessionId"] = parent
        annotated.append(result)
    return {**snapshot, "sessions": annotated,
            "annotationSource": "user-confirmed ground truth, not live T3 metadata"}


def export_web_training(snapshot: dict, index: dict, truth: dict, output: Path) -> None:
    """Compile filename statistics and user-confirmed session labels for the UI.

    Learning data is keyed to workspace directories and session IDs, not
    manually curated terms; the client generalizes to unseen session titles.
    """
    projects = {project["id"]: project for project in snapshot["projects"]}
    aliases = {part.casefold(): p for p in projects.values()
               for part in (p["id"], p["title"])}
    labels = {}
    for session_id, project in truth.get("projectBySessionId", {}).items():
        # Multiple alternatives have no uniquely approved assignment.
        if not isinstance(project, str):
            continue
        match = aliases.get(project.casefold())
        if match:
            labels[session_id] = match["title"]
    corrections = {
        session_id: {
            **({"project": labels[session_id]} if session_id in labels else {}),
            **({"parentSessionId": parent} if parent else {}),
        }
        for session_id, parent in truth.get("parentBySessionId", {}).items()
    }
    for session_id, project in labels.items():
        corrections.setdefault(session_id, {})["project"] = project
    training = [
        {"title": session["title"], "project": labels[session["id"]]}
        for session in snapshot["sessions"] if session["id"] in labels
    ]
    vocabulary = {
        project["workspaceRoot"].replace("\\", "/").casefold():
            {word: count for word, count in index.get(project_id, {}).items()
             if count >= 4}
        for project_id, project in projects.items()
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "version": 1,
        "vocabularyByWorkspace": vocabulary,
        "confirmedSessionMetadata": corrections,
        "training": training,
    }, separators=(",", ":"), ensure_ascii=False)+"\n", encoding="utf-8")


def report(snapshot: dict, predictions: dict) -> str:
    projects = {project["id"]: project["title"] for project in snapshot["projects"]}
    lines = ["# ChatGPT grouping experiment", "",
             f"Captured: {snapshot['capturedAt']}", "",
             "Predictions below are **not** user-confirmed ground truth.",
             "No live T3 session metadata is modified.", "",
             "| # | Hidden | Title | Suggested project | Confidence | Parent ID |",
             "|---:|:---:|---|---|---:|---|"]
    for index, session in enumerate(snapshot["sessions"]):
        result = predictions["projects"][session["id"]]
        label = projects.get(result["project"], "Unassigned")
        title = session["title"].replace("|", " / ").replace("\n", " ")
        lines.append(f"| {index} | {'yes' if session.get('hidden') else 'no'} | {title} "
                     f"| {label} | {result['confidence']} | {session.get('parentSessionId') or '-'} |")
    lines += ["", "## Unregistered, name-like candidate groups", ""]
    for label, ids in predictions["unknownNameClusters"].items():
        titles = [s["title"] for s in snapshot["sessions"] if s["id"] in ids]
        lines.append(f"- **{label}**: " + "; ".join(titles))
    lines += ["", "## Ground-truth labeling", "",
              "Fill `ground-truth.json` with session IDs as keys, registered project IDs as values, "
              "and explicit parent-child session IDs where known. Null means explicitly none.",
              "Unlabeled entries are skipped by `--evaluate`.", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=DATA)
    parser.add_argument("--index-workspaces", action="store_true",
                        help="Rescan local workspace filenames; never read source contents")
    parser.add_argument("--evaluate", action="store_true")
    parser.add_argument("--export-web", action="store_true",
                        help="Generate compact trained runtime classifier data for T3 frontend")
    parser.add_argument("--annotate", action="store_true",
                        help="Write confirmed labels to a separate offline fixture")
    args = parser.parse_args()
    data = args.data
    snapshot = json.loads((data/"snapshot.json").read_text(encoding="utf-8"))
    index_path = data/"workspace-index.json"
    if args.index_workspaces:
        index = workspace_index(snapshot["projects"])
        index_path.write_text(json.dumps(index, ensure_ascii=False) + "\n", encoding="utf-8")
    else:
        index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    predicted = predict(snapshot, index)
    (data/"predictions.json").write_text(json.dumps(predicted, indent=2,
                                                    ensure_ascii=False)+"\n", encoding="utf-8")
    (data/"report.md").write_text(report(snapshot, predicted)+"\n", encoding="utf-8")
    truth_path = data/"ground-truth.json"
    create_template(snapshot, truth_path)
    projects = {project["id"]: project["title"] for project in snapshot["projects"]}
    visible = [s for s in snapshot["sessions"] if not s.get("hidden")]
    print(f"Captured {len(snapshot['sessions'])} sessions, {len(snapshot['projects'])} projects.")
    for row in visible:
        result = predicted["projects"][row["id"]]
        print(f"{row['id'][:8]}  {row['title'][:42]:42}  -> "
              f"{projects.get(result['project'], 'unassigned')} "
              f"(confidence {result['confidence']})")
    print("Saved:", data/"report.md")
    print("User truth:", truth_path)
    if args.evaluate or args.annotate or args.export_web:
        truth = json.loads(truth_path.read_text(encoding="utf-8"))
        print("Raw prediction agreement (before feedback):")
        print(json.dumps(evaluate(snapshot, predicted, truth), indent=2))
        if args.export_web:
            path = ROOT/"apps/web/src/chatGPTGroupingTraining.generated.json"
            export_web_training(snapshot, index, truth, path)
            print("Exported learned training:", path)
        if args.annotate:
            annotated = apply_confirmed_feedback(snapshot, truth)
            (data/"annotated-snapshot.json").write_text(
                json.dumps(annotated, indent=2, ensure_ascii=False)+"\n", encoding="utf-8")
            corrected = predict(annotated, index)
            print("Corrected offline fixture agreement (after user feedback):")
            print(json.dumps(evaluate(annotated, corrected, truth), indent=2))
            print("Saved corrected fixture:", data/"annotated-snapshot.json")


if __name__ == "__main__":
    main()
