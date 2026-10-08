from copy import deepcopy
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.config import Settings, get_settings
from app.routers.operations import ChangeApproval, ChangeCreate, CollectionCreate, public_router
from app.security import hash_public_token, rate_limiter
from app.supabase_client import get_supabase


def test_operations_reject_invalid_amount_consent_and_empty_collection():
    with pytest.raises(ValidationError):
        ChangeApproval(signer_name='Jane', signer_job_role='Director', consent=False)
    with pytest.raises(ValidationError):
        ChangeCreate(agreement_id=uuid4(), title='Change', description='A detailed scope change for the project.', amount=-1)
    with pytest.raises(ValidationError):
        CollectionCreate(title='Collection', project_ids=[])


def test_change_approval_is_one_time_and_does_not_expose_private_evidence():
    settings = Settings(_env_file=None, supabase_url='https://example.supabase.co', supabase_publishable_key='public', supabase_secret_key='secret')
    token = 'a' * 43
    record = {'id':str(uuid4()), 'status':'sent', 'title':'Add checkout', 'description':'Add a payment gateway to the agreed store.', 'amount':'25000', 'currency':'LKR', 'extra_days':3, 'access_token_hash':hash_public_token(token), 'created_by':'private-actor', 'signer_ip':'private-ip'}
    class Query:
        def __init__(self, table): self.table=table; self.filters=[]; self.patch=None
        def select(self, _): return self
        def eq(self,key,value): self.filters.append(lambda row: row.get(key)==value); return self
        def in_(self,key,values): self.filters.append(lambda row: row.get(key) in values); return self
        def limit(self,_): return self
        def update(self,patch): self.patch=patch; return self
        def insert(self,_): return self
        def execute(self):
            if self.table=='audit_logs': return SimpleNamespace(data=[])
            if not all(f(record) for f in self.filters): return SimpleNamespace(data=[])
            if self.patch: record.update(self.patch)
            return SimpleNamespace(data=[deepcopy(record)])
    app=FastAPI(); app.include_router(public_router)
    app.dependency_overrides[get_settings]=lambda:settings
    app.dependency_overrides[get_supabase]=lambda:SimpleNamespace(service=SimpleNamespace(table=Query))
    rate_limiter.clear(); client=TestClient(app)
    opened=client.get(f'/public/changes/{token}')
    assert opened.status_code==200
    assert 'private' not in opened.text and 'access_token_hash' not in opened.text
    data={'signer_name':'Jane Client','signer_job_role':'Owner','consent':True}
    assert client.post(f'/public/changes/{token}/approve',json=data).status_code==200
    assert record['consent'] and record['approved_at']
    assert client.post(f'/public/changes/{token}/approve',json=data).status_code==409
    record['access_token_hash']=None
    assert client.get(f'/public/changes/{token}').status_code==404
