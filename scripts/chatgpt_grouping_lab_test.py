"""Regression tests for the offline ChatGPT grouping experiment."""
from pathlib import Path
import json
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from chatgpt_grouping_lab import (
    apply_confirmed_feedback, classify_session, discover_clusters, evaluate, predict, project_name_score,
)


class GroupingLabTests(unittest.TestCase):
    def setUp(self):
        self.projects = [
            {"id": "war", "title": "Wartribes", "workspaceRoot": "D:/Wartribes"},
            {"id": "cit", "title": "CitizenImperium",
             "workspaceRoot": "D:/Unreal/CitizenImperium"},
            {"id": "branch", "title": "main", "workspaceRoot": "D:/Omnish/main"},
            *[{"id": f"extra{i}", "title": f"OtherProject{i}",
               "workspaceRoot": f"D:/OtherProject{i}"} for i in range(8)],
        ]

    def test_worktree_branch_name_not_matching_unrelated_title(self):
        self.assertEqual(
            project_name_score("GRAPPLE MAIN", self.projects[-1]), 0,
        )

    def test_project_vocabulary_recovers_context_without_name_in_title(self):
        index = {
            "war": {"grapple": 45, "combat": 58},
            "cit": {"character": 27},
            "branch": {"main": 15},
        }
        for title in ["GRAPPLE MAIN", "COMBAT TASKS"]:
            classified = classify_session({"id": title, "title": title},
                                          self.projects, index)
            self.assertEqual(classified["project"], "war")
        self.assertEqual(
            classify_session({"title": "Citizen Imperium gameplay"},
                             self.projects, index)["project"], "cit"
        )

    def test_repeated_generic_word_not_a_project(self):
        sessions = [
            {"id": "a", "title": "Try using omcp to read files"},
            {"id": "b", "title": "Try spawning a chatgpt subagent using omcp"},
        ]
        classifications = {s["id"]: {"project": None} for s in sessions}
        self.assertNotIn("using", discover_clusters(
            sessions, classifications, self.projects))

    def test_unregistered_repeated_name_beats_filename_overlap(self):
        sessions = [
            {"id": "a", "title": "Cascadeur RE - Update Graph"},
            {"id": "b", "title": "Cascadeur RE - Tool Physics"},
            {"id": "c", "title": "REA cascadeur"},
        ]
        snapshot = {"capturedAt": "test", "projects": self.projects,
                    "sessions": sessions}
        index = {"war": {"physics": 100, "update": 100}, "cit": {},
                 "branch": {}}
        result = predict(snapshot, index)
        self.assertEqual(set(result["unknownNameClusters"]["cascadeur"]),
                         {"a", "b", "c"})
        for s in sessions:
            self.assertIsNone(result["projects"][s["id"]]["project"])
            self.assertEqual(result["projects"][s["id"]]["customGroup"],
                             "cascadeur")
        self.assertEqual(result["parentLinks"], {})

    def test_user_feedback_isolated_from_raw_snapshot(self):
        snapshot = {"capturedAt": "test", "projects": self.projects,
                    "sessions": [
                        {"id": "parent", "title": "Try spawning test", "parentSessionId": None},
                        {"id": "child", "title": "OMCP Subagent Spawn Test", "parentSessionId": None},
                        {"id": "other", "title": "Unrelated"},
                    ]}
        labels = {
            "projectBySessionId": {"child": ["Omni", "t3code"], "other": "Wartribes"},
            "parentBySessionId": {"child": "parent"},
        }
        # The fixture uses local project IDs, so ambiguous options are left
        # uncommitted even when they refer to projects elsewhere.
        annotated = apply_confirmed_feedback(snapshot, labels)
        self.assertIsNone(snapshot["sessions"][1]["parentSessionId"])
        self.assertEqual(annotated["sessions"][1]["parentSessionId"], "parent")
        self.assertEqual(annotated["sessions"][1]["projectChoices"], ["Omni", "t3code"])
        self.assertEqual(annotated["sessions"][2]["project"], "Wartribes")
        expected = evaluate(annotated, {"projects": {
            "other": {"project": "war"}, "child": {"project": None}
        }, "parentLinks": {"child": "parent"}, "unknownNameClusters": {}}, labels)
        self.assertEqual(expected["project"]["correct"], 1)
        self.assertEqual(expected["project"]["labeled"], 1)
        self.assertEqual(expected["project"]["ambiguousUnscored"], 1)
        self.assertEqual(expected["parent"]["correct"], 1)

    def test_ground_truth_is_not_automatically_fabricated(self):
        snapshot = {"capturedAt": "test", "projects": self.projects,
                    "sessions": [{"id": "a", "title": "Wartribes combat"}]}
        result = predict(snapshot, {})
        verdict = evaluate(snapshot, result, {
            "projectBySessionId": {"a": "Wartribes"},
            "parentBySessionId": {"a": "unknown-parent"},
        })
        self.assertEqual(verdict["project"]["correct"], 1)
        self.assertEqual(verdict["parent"]["correct"], 0)
        self.assertEqual(verdict["parent"]["labeled"], 1)


if __name__ == "__main__":
    unittest.main()
