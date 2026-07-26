"""Worker entrypoint plumbing. Skipped unless the `livekit` extra is installed.

Only the parts that decide *who the learner is* are covered here. The rest of
the entrypoint is a wiring diagram between components that have their own tests,
but identity is different: it feeds straight into the retrieval ACL filter, so
getting it wrong serves one learner's documents to another.
"""

from __future__ import annotations

import json
import logging
from unittest.mock import MagicMock

import pytest

pytest.importorskip("livekit.agents", reason="requires the livekit extra")

from tutor_agent.adapters.worker import (  # noqa: E402
    DEFAULT_PERSONA,
    LearnerIdentity,
    _log_client_hello,
)


def _participant(metadata: str | None, identity: str = "learner-abc123") -> MagicMock:
    participant = MagicMock()
    participant.metadata = metadata
    participant.identity = identity
    return participant


class TestLearnerIdentity:
    def test_reads_the_signed_token_metadata(self):
        learner = LearnerIdentity.parse(
            _participant(json.dumps({"user_id": "u-1", "persona": "coach-rios"}))
        )
        assert learner.user_id == "u-1"
        assert learner.persona_id == "coach-rios"

    def test_persona_falls_back_to_the_worker_default(self):
        learner = LearnerIdentity.parse(_participant(json.dumps({"user_id": "u-1"})))
        assert learner.persona_id == DEFAULT_PERSONA

    @pytest.mark.parametrize(
        "metadata",
        [None, "", "not json", "[1, 2, 3]", '"a string"', "{}", '{"user_id": null}'],
    )
    def test_anything_unusable_yields_no_user_id(self, metadata):
        """Every one of these must land on 'anonymous', never on a shared id.

        The entrypoint disables retrieval when user_id is empty. If this
        returned a placeholder like 'dev' instead, every anonymous session would
        share one retrieval scope — and on a machine where someone had ingested
        under that id, a stranger's documents would be in the tutor's context.
        """
        learner = LearnerIdentity.parse(_participant(metadata))
        assert learner.user_id == ""
        assert learner.persona_id == DEFAULT_PERSONA

    def test_a_missing_id_is_logged_loudly(self, caplog):
        with caplog.at_level(logging.WARNING):
            LearnerIdentity.parse(_participant("{}"))
        assert "retrieval will be disabled" in caplog.text


class TestClientHello:
    def test_a_matching_client_is_not_warned_about(self, caplog):
        from tutor_agent.core.protocol import action_names, protocol_version

        with caplog.at_level(logging.WARNING):
            _log_client_hello(
                {
                    "type": "client_hello",
                    "protocolVersion": protocol_version(),
                    "supportedActions": list(action_names()),
                },
                "learner-abc123",
            )
        assert caplog.text == ""

    def test_a_version_mismatch_is_warned_about(self, caplog):
        with caplog.at_level(logging.WARNING):
            _log_client_hello(
                {"protocolVersion": "0.0.1", "supportedActions": []}, "learner-abc123"
            )
        assert "protocol mismatch" in caplog.text

    def test_actions_the_client_cannot_render_are_named(self, caplog):
        from tutor_agent.core.protocol import action_names, protocol_version

        supported = [name for name in action_names() if name != "spawn_sim"]
        with caplog.at_level(logging.WARNING):
            _log_client_hello(
                {"protocolVersion": protocol_version(), "supportedActions": supported},
                "learner-abc123",
            )
        # "The tutor said it was drawing a simulation and nothing appeared" is
        # otherwise very hard to diagnose from either side alone.
        assert "spawn_sim" in caplog.text

    def test_a_malformed_hello_does_not_raise(self):
        _log_client_hello({}, None)
        _log_client_hello({"supportedActions": "not a list"}, "x")
