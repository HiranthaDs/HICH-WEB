from __future__ import annotations

import pytest
from pydantic import ValidationError
from uuid import uuid4

from app.models import AgreementCreate, InvoiceCreate, SignAgreementRequest


def test_agreement_accepts_description_or_legacy_content() -> None:
    agreement = AgreementCreate(
        client_name="Example Client",
        title="Website delivery agreement",
        content="A sufficiently detailed agreement description for testing.",
    )
    assert agreement.description == agreement.content


def test_agreement_requires_client_reference() -> None:
    with pytest.raises(ValidationError, match="client_id or client_name"):
        AgreementCreate(
            title="Website delivery agreement",
            description="A sufficiently detailed agreement description for testing.",
        )


def test_signature_requires_consent_and_one_signature_form() -> None:
    evidence = {"signer_job_role": "Director", "expected_version": 1, "expected_content_sha256": "a" * 64}
    with pytest.raises(ValidationError, match="Explicit consent"):
        SignAgreementRequest(signer_name="Jane Client", typed_signature="Jane Client", consent=False, **evidence)
    with pytest.raises(ValidationError, match="typed or drawn"):
        SignAgreementRequest(signer_name="Jane Client", consent=True, **evidence)
    valid = SignAgreementRequest(signer_name="Jane Client", typed_signature="Jane Client", consent=True, **evidence)
    assert valid.signer_email is None


def test_invoice_payment_phases_must_match_project_value() -> None:
    with pytest.raises(ValidationError, match="payment phases must add up"):
        InvoiceCreate(
            client_id=uuid4(),
            amount="1000",
            payments=[{"name": "Advance", "amount": "400"}],
        )

    invoice = InvoiceCreate(
        client_id=uuid4(),
        amount="1000",
        payments=[
            {"name": "Advance", "amount": "400"},
            {"name": "Balance", "amount": "600"},
        ],
    )
    assert invoice.project_value == 1000
