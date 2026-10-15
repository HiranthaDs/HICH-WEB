from copy import deepcopy
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

from app.config import Settings
from app.models import ProposalCreate, ProposalShareRequest, ProposalUpdate
from app.routers import proposals


class Query:
    def __init__(self, records):
        self.records = records
        self.filters = []
        self.changes = None
        self.inserted = None
        self.start, self.end = 0, None

    def select(self, _): return self
    def order(self, *_, **__): return self
    def limit(self, limit): self.end = limit; return self
    def range(self, start, end): self.start, self.end = start, end + 1; return self
    def eq(self, key, value): self.filters.append(lambda row: str(row.get(key)) == str(value)); return self
    def is_(self, key, value):
        assert value == "null"
        self.filters.append(lambda row: row.get(key) is None)
        return self
    def in_(self, key, values): self.filters.append(lambda row: row.get(key) in values); return self
    def update(self, changes): self.changes = changes; return self
    def insert(self, record): self.inserted = deepcopy(record); return self

    def execute(self):
        if self.inserted is not None:
            created = {
                "id": str(uuid4()), "version": 1, "deleted_at": None,
                "access_token_hash": None, "share_nonce": None,
                "created_at": "2026-10-12T00:00:00Z", "updated_at": "2026-10-12T00:00:00Z",
            } | self.inserted
            self.records.append(created)
            return SimpleNamespace(data=[deepcopy(created)])
        matches = [row for row in self.records if all(test(row) for test in self.filters)]
        if self.changes is not None:
            for row in matches:
                row.update(deepcopy(self.changes))
        return SimpleNamespace(data=deepcopy(matches[self.start:self.end]))


def gateway(records):
    records.setdefault("document_open_counts", [])
    openings = set()

    class ViewRpc:
        def __init__(self, payload):
            self.payload = payload

        def execute(self):
            matches = [row for row in records["proposals"] if row["id"] == self.payload["p_proposal_id"]
                       and row.get("access_token_hash") == self.payload["p_access_token_hash"]
                       and row.get("status") in {"sent", "viewed"} and row.get("deleted_at") is None]
            if not matches:
                return SimpleNamespace(data=[])
            row = matches[0]
            opening_key = (row["id"], self.payload["p_opening_id"])
            first_opened = row["status"] == "sent" and opening_key not in openings
            if first_opened:
                row.update({"status": "viewed", "viewed_at": "2026-10-14T08:00:00Z"})
            counters = records["document_open_counts"]
            count = next((item for item in counters if item["document_type"] == "proposal" and item["document_id"] == row["id"]), None)
            if count is None:
                count = {"document_type": "proposal", "document_id": row["id"], "open_count": 0}
                counters.append(count)
            if opening_key not in openings:
                count["open_count"] += 1
                openings.add(opening_key)
                count["last_opened_at"] = "2026-10-14T08:00:00Z"
            return SimpleNamespace(data=[{"document_status": row["status"], "first_viewed_at": row["viewed_at"],
                                          "view_count": count["open_count"], "last_opened_at": count["last_opened_at"],
                                          "first_opened": first_opened}])

    return SimpleNamespace(service=SimpleNamespace(
        table=lambda table: Query(records[table]),
        rpc=lambda name, payload: ViewRpc(payload) if name == "record_proposal_open" else None,
    ))


def settings():
    return Settings(
        supabase_url="https://example.supabase.co",
        supabase_publishable_key="publishable",
        supabase_secret_key="secret",
        public_app_url="https://portal.example.com",
    )


def request():
    return SimpleNamespace(state=SimpleNamespace(request_id="test"), headers={}, client=None)


def proposal_record(status="draft"):
    public_id, nonce = uuid4(), uuid4()
    token = proposals._proposal_token(str(public_id), str(nonce))
    return {
        "id": str(uuid4()),
        "public_id": str(public_id),
        "client_id": str(uuid4()),
        "client_name": "Example Client",
        "client_email": "client@example.com",
        "client_phone": "+94770000000",
        "reference": "PROP-100001",
        "title": "Responsive system proposal",
        "html_content": "<!doctype html><html><body><h1>Proposal</h1></body></html>",
        "content_sha256": "a" * 64,
        "status": status,
        "version": 1,
        "share_nonce": str(nonce) if status != "draft" else None,
        "access_token_hash": proposals._token_hash(token) if status != "draft" else None,
        "deleted_at": None,
        "clients": {"name": "Example Client", "company": "Example Co"},
    }, token


def test_proposal_payload_accepts_complete_html():
    payload = ProposalCreate(
        client_id=uuid4(),
        title="Vehicle ERP proposal",
        html_content="<!doctype html><html><body>Complete proposal</body></html>",
    )
    assert payload.reference is None
    assert payload.html_content.startswith("<!doctype html>")


def test_create_and_list_keep_the_exact_client_relationship(monkeypatch):
    client_id = uuid4()
    records = {
        "clients": [{
            "id": str(client_id), "name": "Contact Person", "company": "Example Company",
            "email": "client@example.com", "phone": "+94770000000", "address": "Colombo",
            "deleted_at": None,
        }],
        "proposals": [],
    }
    db = gateway(records)
    monkeypatch.setattr(proposals, "audit", lambda *args, **kwargs: None)

    created = proposals.create_proposal(
        ProposalCreate(
            client_id=client_id,
            title="Linked quotation",
            html_content="<!doctype html><html><body>Complete quotation</body></html>",
        ),
        request(),
        SimpleNamespace(id=uuid4()),
        settings(),
        db,
    )["proposal"]

    assert created["client_id"] == str(client_id)
    assert created["client_name"] == "Contact Person"
    assert records["proposals"][0]["client_id"] == str(client_id)
    listed = proposals.list_proposals(None, 100, 0, None, settings(), db)["proposals"]["items"]
    assert [item["id"] for item in listed] == [created["id"]]


def test_relinking_client_revokes_the_old_public_link(monkeypatch):
    record, old_token = proposal_record("sent")
    record.pop("clients", None)
    replacement_id = uuid4()
    records = {
        "clients": [{
            "id": str(replacement_id), "name": "Replacement Client", "company": "Replacement Co",
            "email": "replacement@example.com", "phone": None, "address": None, "deleted_at": None,
        }],
        "proposals": [record],
    }
    db = gateway(records)
    monkeypatch.setattr(proposals, "audit", lambda *args, **kwargs: None)

    updated = proposals.update_proposal(
        UUID(record["id"]),
        ProposalUpdate(client_id=replacement_id, expected_version=1),
        request(),
        SimpleNamespace(id=uuid4()),
        settings(),
        db,
    )["proposal"]

    assert updated["client_id"] == str(replacement_id)
    assert updated["client_name"] == "Replacement Client"
    assert updated["status"] == "draft"
    assert updated["version"] == 2
    assert records["proposals"][0]["access_token_hash"] is None
    assert records["proposals"][0]["share_nonce"] is None
    with pytest.raises(HTTPException) as exc_info:
        proposals.public_proposal(old_token, request(), settings(), db)
    assert exc_info.value.status_code == 404


def test_admin_shape_recovers_stable_link_without_exposing_secrets():
    record, token = proposal_record("sent")
    shaped = proposals._shape(record, settings())
    assert shaped["share_url"] == f"https://portal.example.com/proposal/{token}"
    assert "access_token_hash" not in shaped
    assert "share_nonce" not in shaped


def test_public_shape_has_an_explicit_boundary():
    record, _ = proposal_record("viewed")
    shaped = proposals._public_shape(record)
    assert shaped["html_content"].startswith("<!doctype html>")
    assert shaped["client_name"] == "Example Client"
    for forbidden in ("client_email", "client_phone", "client_id", "access_token_hash", "share_nonce", "created_by"):
        assert forbidden not in shaped


def test_sharing_and_first_public_view_keep_one_stable_link(monkeypatch):
    record, _ = proposal_record("draft")
    records = {"proposals": [record]}
    db = gateway(records)
    monkeypatch.setattr(proposals, "audit", lambda *args, **kwargs: None)
    principal = SimpleNamespace(id=uuid4())

    shared = proposals.share_proposal(
        UUID(record["id"]),
        request(),
        ProposalShareRequest(),
        principal,
        settings(),
        db,
    )["share"]
    token = shared["token"]
    assert records["proposals"][0]["status"] == "sent"
    assert shared["share_url"].endswith(f"/proposal/{token}")

    public = proposals.public_proposal(token, request(), settings(), db)["proposal"]
    assert public["status"] == "sent"
    assert records["document_open_counts"] == []
    opening = proposals.ProposalOpenRequest(opening_id=uuid4())
    proposals.open_proposal(token, opening, request(), settings(), db)
    assert public["title"] == record["title"]
    assert records["proposals"][0]["viewed_at"]
    viewed_at = records["proposals"][0]["viewed_at"]
    sent_at = records["proposals"][0]["sent_at"]
    assert records["document_open_counts"][0]["open_count"] == 1

    proposals.public_proposal(token, request(), settings(), db)
    proposals.open_proposal(token, opening, request(), settings(), db)
    assert records["document_open_counts"][0]["open_count"] == 1
    proposals.open_proposal(token, proposals.ProposalOpenRequest(opening_id=uuid4()), request(), settings(), db)
    assert records["document_open_counts"][0]["open_count"] == 2
    assert records["proposals"][0]["viewed_at"] == viewed_at

    copied_again = proposals.share_proposal(
        UUID(record["id"]), request(), ProposalShareRequest(), principal, settings(), db,
    )["share"]
    assert copied_again["token"] == token
    assert records["proposals"][0]["status"] == "viewed"
    assert records["proposals"][0]["sent_at"] == sent_at
    assert records["proposals"][0]["viewed_at"] == viewed_at


def test_opening_id_is_scoped_to_its_proposal(monkeypatch):
    first_record, first_token = proposal_record("sent")
    second_record, second_token = proposal_record("sent")
    records = {"proposals": [first_record, second_record]}
    db = gateway(records)
    monkeypatch.setattr(proposals, "audit", lambda *args, **kwargs: None)
    opening = proposals.ProposalOpenRequest(opening_id=uuid4())
    proposals.open_proposal(first_token, opening, request(), settings(), db)
    proposals.open_proposal(second_token, opening, request(), settings(), db)
    assert [item["open_count"] for item in records["document_open_counts"]] == [1, 1]


@pytest.mark.parametrize("state", ["revoked", "archived", "deleted"])
def test_invalid_public_links_cannot_record_opens(monkeypatch, state):
    record, token = proposal_record("sent")
    if state == "revoked":
        record["access_token_hash"] = "f" * 64
    elif state == "archived":
        record["status"] = "archived"
    else:
        record["deleted_at"] = "2026-10-15T00:00:00Z"
    records = {"proposals": [record]}
    db = gateway(records)
    monkeypatch.setattr(proposals, "audit", lambda *args, **kwargs: None)
    with pytest.raises(HTTPException) as exc:
        proposals.open_proposal(token, proposals.ProposalOpenRequest(opening_id=uuid4()), request(), settings(), db)
    assert exc.value.status_code == 404
    assert records["document_open_counts"] == []

