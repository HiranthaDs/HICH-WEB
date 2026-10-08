from copy import deepcopy
import re
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.config import Settings, get_settings
from app.dependencies import current_admin
from app.models import AgreementCreate, AgreementUpdate, PortfolioProjectCreate, PortfolioProjectUpdate
from app.routers.portfolio import _slugify, router
from app.supabase_client import get_supabase


@pytest.mark.parametrize("supplied,expected", [
    ("Storefront Redesign", "storefront-redesign"),
    ("  Café Storefront — 2026 / Desktop  ", "cafe-storefront-2026-desktop"),
    ("MY___PROJECT--", "my-project"),
    ("   ", None),
    ("---", None),
    ("a" * 239 + "-extra", "a" * 239),
])
def test_project_inputs_normalize_manual_slugs(supplied, expected):
    created = PortfolioProjectCreate(title="Project", main_description="A project preview", slug=supplied, url="   ")
    updated = PortfolioProjectUpdate(slug=supplied, url="   ")
    assert created.slug == updated.slug == expected
    assert created.url is None and updated.url is None


def test_generated_slugs_remain_valid_at_truncation_boundary():
    assert _slugify("a" * 219 + " next") == "a" * 219
    assert re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", _slugify("✨"))


@pytest.mark.parametrize("currency", ["LKR", "USD", "GBP"])
def test_agreement_renewals_support_all_offered_currencies(currency):
    assert AgreementCreate(client_name="Client", renewal_amount="125", renewal_currency=currency).renewal_currency == currency
    assert AgreementUpdate(renewal_currency=currency).renewal_currency == currency


def test_project_create_and_edit_accept_human_readable_slugs():
    records = []

    class Query:
        def __init__(self, table):
            self.table = table
            self.filters = []
            self.inserted = None
            self.patch = None

        def select(self, _): return self
        def eq(self, key, value):
            self.filters.append((key, value))
            return self
        def limit(self, _): return self
        def insert(self, record):
            self.inserted = record
            return self
        def update(self, patch):
            self.patch = patch
            return self
        def execute(self):
            if self.table == "audit_logs": return SimpleNamespace(data=[])
            if self.inserted is not None:
                records.append({"id": str(uuid4()), "portfolio_images": [], **deepcopy(self.inserted)})
                return SimpleNamespace(data=[deepcopy(records[-1])])
            found = [record for record in records if all(record.get(key) == value for key, value in self.filters)]
            if self.patch is not None:
                for record in found: record.update(self.patch)
            return SimpleNamespace(data=deepcopy(found))

    settings = Settings(_env_file=None, supabase_url="https://example.supabase.co", supabase_publishable_key="public", supabase_secret_key="secret")
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[current_admin] = lambda: SimpleNamespace(id=uuid4())
    app.dependency_overrides[get_supabase] = lambda: SimpleNamespace(service=SimpleNamespace(table=Query))
    client = TestClient(app)
    response = client.post("/portfolio", json={"title": "Storefront", "main_description": "A project preview", "slug": "  My Store / Desktop "})
    assert response.status_code == 201, response.text
    project = response.json()["project"]
    assert project["slug"] == "my-store-desktop"
    response = client.patch(f"/portfolio/{project['id']}", json={"slug": "Updated Project!"})
    assert response.status_code == 200, response.text
    assert response.json()["project"]["slug"] == "updated-project"
    response = client.patch(f"/portfolio/{project['id']}", json={"slug": " "})
    assert response.status_code == 200
    assert response.json()["project"]["slug"] == "updated-project"
    response = client.post("/portfolio", json={"title": "Automatic Project", "main_description": "A project preview", "slug": " "})
    assert response.status_code == 201, response.text
    assert response.json()["project"]["slug"] == "automatic-project"
