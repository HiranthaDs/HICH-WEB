from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, HttpUrl, field_validator, model_validator

from .slugs import normalize_project_slug


class APIModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginRequest(APIModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)


class UserResponse(APIModel):
    id: UUID
    email: EmailStr
    full_name: str | None = None
    role: str = "admin"


class SessionResponse(APIModel):
    user: UserResponse
    csrf_token: str
    expires_in: int


class MessageResponse(APIModel):
    message: str


class ClientStatus(StrEnum):
    LEAD = "lead"
    ACTIVE = "active"
    INACTIVE = "inactive"
    ARCHIVED = "archived"


class ClientBase(APIModel):
    name: str = Field(min_length=1, max_length=160)
    company: str | None = Field(default=None, max_length=200)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=1000)
    status: ClientStatus = ClientStatus.ACTIVE
    notes: str | None = Field(default=None, max_length=5000)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("email", mode="before")
    @classmethod
    def blank_email_is_none(cls, value: object) -> object:
        return None if value == "" else value


class ClientCreate(ClientBase):
    pass


class ClientUpdate(APIModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    company: str | None = Field(default=None, max_length=200)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=40)
    address: str | None = Field(default=None, max_length=1000)
    status: ClientStatus | None = None
    notes: str | None = Field(default=None, max_length=5000)
    metadata: dict[str, Any] | None = None

    @field_validator("email", mode="before")
    @classmethod
    def blank_email_is_none(cls, value: object) -> object:
        return None if value == "" else value


class ClientResponse(ClientBase):
    id: UUID
    created_by: UUID | None = None
    created_at: datetime
    updated_at: datetime


class AgreementStatus(StrEnum):
    DRAFT = "draft"
    SENT = "sent"
    VIEWED = "viewed"
    SIGNED = "signed"
    VOID = "void"
    EXPIRED = "expired"


class AgreementPaymentPhase(APIModel):
    name: str = Field(min_length=1, max_length=240)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    is_paid: bool = False
    paid_at: datetime | None = None
    received_amount: Decimal = Field(default=0, ge=0, max_digits=14, decimal_places=2)


class AgreementCreate(APIModel):
    commercial_details_visible: bool = True
    source_invoice_id: UUID | None = None
    visiting_fee_lkr: Decimal = Field(default=0, ge=0, le=15000, decimal_places=2)
    payment_schedule: list[AgreementPaymentPhase] = Field(default_factory=list, max_length=100)
    payment_instructions: str | None = Field(default=None, max_length=5000)
    project_due_date: date | None = None
    renewal_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    renewal_currency: str = Field(default="LKR", pattern=r"^(USD|LKR|GBP)$")
    renewal_due_date: date | None = None
    reference: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9_./-]*$")
    client_id: UUID | None = None
    client_name: str | None = Field(default=None, min_length=1, max_length=160)
    client_email: EmailStr | None = None
    client_phone: str | None = Field(default=None, min_length=3, max_length=40)
    project_id: UUID | None = None
    title: str = Field(default="General Website & System Development Agreement", min_length=1, max_length=240)
    project_title: str | None = Field(default=None, max_length=240)
    description: str | None = Field(default=None, min_length=20, max_length=100_000)
    content: str | None = Field(default=None, min_length=20, max_length=100_000)
    terms: str | list[str] | dict[str, Any] = Field(default_factory=dict)
    amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    currency: str = Field(default="LKR", min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    expires_at: datetime | None = None
    status: AgreementStatus = AgreementStatus.DRAFT
    send_immediately: bool = False

    @field_validator("expires_at", "reference", "client_email", "client_phone", "renewal_due_date", mode="before")
    @classmethod
    def blank_expiry_is_none(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def description_is_required(self) -> "AgreementCreate":
        from .agreement_template import PROJECT_OVERVIEW, default_terms
        if not self.terms:
            self.terms = default_terms()
        if not self.description and not self.content:
            self.description = PROJECT_OVERVIEW
        if not self.description:
            self.description = self.content
        if not self.client_id and not self.client_name:
            raise ValueError("client_id or client_name is required")
        if self.expires_at and self.expires_at.tzinfo is None:
            raise ValueError("expires_at must include a timezone")
        if self.status not in {AgreementStatus.DRAFT, AgreementStatus.SENT}:
            raise ValueError("New agreements must be draft or sent")
        if self.status == AgreementStatus.SENT:
            self.send_immediately = True
        return self


class AgreementUpdate(APIModel):
    commercial_details_visible: bool | None = None
    source_invoice_id: UUID | None = None
    visiting_fee_lkr: Decimal | None = Field(default=None, ge=0, le=15000, decimal_places=2)
    payment_schedule: list[AgreementPaymentPhase] | None = Field(default=None, max_length=100)
    payment_instructions: str | None = Field(default=None, max_length=5000)
    project_due_date: date | None = None
    renewal_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    renewal_currency: str | None = Field(default=None, pattern=r"^(USD|LKR|GBP)$")
    renewal_due_date: date | None = None
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    client_id: UUID | None = None
    reference: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9][A-Za-z0-9_./-]*$")
    project_id: UUID | None = None
    title: str | None = Field(default=None, min_length=1, max_length=240)
    project_title: str | None = Field(default=None, max_length=240)
    description: str | None = Field(default=None, min_length=20, max_length=100_000)
    content: str | None = Field(default=None, min_length=20, max_length=100_000)
    terms: str | list[str] | dict[str, Any] | None = None
    amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    currency: str | None = Field(default=None, min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    expires_at: datetime | None = None
    status: AgreementStatus | None = None
    client_name: str | None = Field(default=None, min_length=1, max_length=160)
    client_email: EmailStr | None = None
    client_phone: str | None = Field(default=None, min_length=3, max_length=40)
    expected_version: int | None = Field(default=None, ge=1)

    @field_validator("expires_at", "client_email", "renewal_due_date", mode="before")
    @classmethod
    def blanks_are_none(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def timezone_required(self) -> "AgreementUpdate":
        if self.expires_at and self.expires_at.tzinfo is None:
            raise ValueError("expires_at must include a timezone")
        return self


class AgreementResponse(APIModel):
    id: UUID
    public_id: UUID
    client_id: UUID
    project_id: UUID | None = None
    title: str
    project_title: str | None = None
    description: str
    content: str | None = None
    terms: str | list[str] | dict[str, Any]
    amount: Decimal | None = None
    commercial_details_visible: bool = True
    currency: str
    status: AgreementStatus
    expires_at: datetime | None = None
    sent_at: datetime | None = None
    viewed_at: datetime | None = None
    signed_at: datetime | None = None
    signer_name: str | None = None
    signer_email: EmailStr | None = None
    signature_sha256: str | None = None
    signed_record_sha256: str | None = None
    created_by: UUID | None = None
    created_at: datetime
    updated_at: datetime
    signing_token: str | None = None
    signing_path: str | None = None
    reference: str | None = None
    client_name: str | None = None
    client_email: EmailStr | None = None
    share_url: str | None = None


class PublicClientSummary(APIModel):
    name: str
    company: str | None = None


class PublicAgreementResponse(APIModel):
    public_id: UUID
    title: str
    project_title: str | None = None
    description: str
    content: str | None = None
    terms: str | list[str] | dict[str, Any]
    amount: Decimal | None = None
    commercial_details_visible: bool = True
    currency: str
    status: AgreementStatus
    expires_at: datetime | None = None
    signed_at: datetime | None = None
    client: PublicClientSummary


class SignAgreementRequest(APIModel):
    signer_name: str = Field(min_length=2, max_length=160)
    signer_job_role: str = Field(min_length=2, max_length=160)
    signer_email: EmailStr | None = None
    typed_signature: str | None = Field(default=None, min_length=2, max_length=160)
    signature_data_url: str | None = Field(default=None, min_length=32, max_length=2_100_000)
    consent: bool = Field(strict=True)
    expected_version: int = Field(ge=1)
    expected_content_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    signed_at: datetime | None = None

    @model_validator(mode="after")
    def consent_is_required(self) -> "SignAgreementRequest":
        if not self.consent:
            raise ValueError("Explicit consent is required")
        if not self.typed_signature and not self.signature_data_url:
            raise ValueError("A typed or drawn signature is required")
        if self.typed_signature and self.signature_data_url:
            raise ValueError("Choose either a typed or drawn signature, not both")
        return self


class SigningResponse(APIModel):
    public_id: UUID
    status: AgreementStatus
    signed_at: datetime
    signed_record_sha256: str


class PortfolioProjectCreate(APIModel):
    project_code: str | None = Field(default=None, min_length=1, max_length=50, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    title: str = Field(min_length=1, max_length=240)
    slug: str | None = Field(default=None, min_length=1, max_length=240, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    url: HttpUrl | None = None
    main_description: str = Field(min_length=1, max_length=10_000)
    sub_description: str | None = Field(default=None, max_length=10_000)
    category: str | None = Field(default=None, max_length=120)
    featured: bool = False
    published: bool = False
    sort_order: int = Field(default=0, ge=-10_000, le=10_000)
    metadata: dict[str, Any] = Field(default_factory=dict)
    images: list[str] = Field(default_factory=list)
    image_urls: list[str] = Field(default_factory=list)

    @field_validator("slug", mode="before")
    @classmethod
    def normalize_slug(cls, value: object) -> object:
        return (normalize_project_slug(value) or None) if isinstance(value, str) else value

    @field_validator("url", mode="before")
    @classmethod
    def blank_optional_fields_are_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value


class PortfolioProjectUpdate(APIModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    project_code: str | None = Field(default=None, min_length=1, max_length=50, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
    title: str | None = Field(default=None, min_length=1, max_length=240)
    slug: str | None = Field(default=None, min_length=1, max_length=240, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    url: HttpUrl | None = None
    main_description: str | None = Field(default=None, min_length=1, max_length=10_000)
    sub_description: str | None = Field(default=None, max_length=10_000)
    category: str | None = Field(default=None, max_length=120)
    featured: bool | None = None
    published: bool | None = None
    sort_order: int | None = Field(default=None, ge=-10_000, le=10_000)
    metadata: dict[str, Any] | None = None
    images: list[str] | None = None
    image_urls: list[str] | None = None

    @field_validator("slug", mode="before")
    @classmethod
    def normalize_slug(cls, value: object) -> object:
        return (normalize_project_slug(value) or None) if isinstance(value, str) else value

    @field_validator("url", mode="before")
    @classmethod
    def blank_optional_fields_are_none(cls, value: object) -> object:
        return None if isinstance(value, str) and not value.strip() else value


class PortfolioImageResponse(APIModel):
    id: UUID
    project_id: UUID
    storage_path: str
    public_url: str | None = None
    alt_text: str | None = None
    position: int
    is_cover: bool
    created_at: datetime


class PortfolioProjectResponse(PortfolioProjectCreate):
    id: UUID
    created_by: UUID | None = None
    created_at: datetime
    updated_at: datetime
    images: list[PortfolioImageResponse] = Field(default_factory=list)


class PortfolioImageUpdate(APIModel):
    alt_text: str | None = Field(default=None, max_length=300)
    position: int | None = Field(default=None, ge=0, le=1000)
    is_cover: bool | None = None


class InvoiceStatus(StrEnum):
    DRAFT = "draft"
    SENT = "sent"
    PARTIAL = "partial"
    PAID = "paid"
    OVERDUE = "overdue"
    VOID = "void"


class MilestoneStatus(StrEnum):
    PENDING = "pending"
    INVOICED = "invoiced"
    PAID = "paid"
    WAIVED = "waived"


class MilestoneCreate(APIModel):
    title: str = Field(min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=2000)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    due_date: date | None = None
    status: MilestoneStatus = MilestoneStatus.PENDING
    position: int = Field(default=0, ge=0, le=1000)


class MilestoneUpdate(APIModel):
    title: str | None = Field(default=None, min_length=1, max_length=240)
    description: str | None = Field(default=None, max_length=2000)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    due_date: date | None = None
    status: MilestoneStatus | None = None
    position: int | None = Field(default=None, ge=0, le=1000)


class MilestoneResponse(MilestoneCreate):
    id: UUID
    invoice_id: UUID
    created_at: datetime
    updated_at: datetime


class InvoicePhaseInput(APIModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    id: UUID | None = None
    name: str = Field(min_length=1, max_length=240)
    amount: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    status: str | None = Field(default=None, max_length=240)
    is_paid: bool = False
    isPaid: bool = False
    paid_at: datetime | None = None


class InvoiceCreate(APIModel):
    client_id: UUID
    agreement_id: UUID | None = None
    invoice_number: str | None = Field(default=None, min_length=1, max_length=80)
    reference: str | None = Field(default=None, min_length=1, max_length=80)
    project_title: str | None = Field(default=None, max_length=240)
    currency: str = Field(default="LKR", min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    project_value: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    renewal_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    renewal_currency: str | None = Field(default=None, min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    renewal_due_date: date | None = None
    issue_date: date = Field(default_factory=date.today)
    due_date: date | None = None
    payment_method: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=5000)
    status: InvoiceStatus = InvoiceStatus.DRAFT
    milestones: list[MilestoneCreate] = Field(default_factory=list, max_length=100)
    payments: list[InvoicePhaseInput] = Field(default_factory=list, max_length=100)
    client_name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    paid_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)

    @field_validator("invoice_number", "reference", "due_date", "renewal_due_date", mode="before")
    @classmethod
    def blank_optional_fields_are_none(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def due_date_is_valid(self) -> "InvoiceCreate":
        if self.project_value is None and self.amount is None:
            raise ValueError("amount is required")
        if self.project_value is None:
            self.project_value = self.amount
        if self.due_date and self.due_date < self.issue_date:
            raise ValueError("due_date cannot be before issue_date")
        if self.payments and sum((phase.amount for phase in self.payments), Decimal()) != self.project_value:
            raise ValueError("payment phases must add up to the project value")
        return self


class InvoiceUpdate(APIModel):
    model_config = ConfigDict(extra="ignore", str_strip_whitespace=True)
    client_id: UUID | None = None
    agreement_id: UUID | None = None
    invoice_number: str | None = Field(default=None, min_length=1, max_length=80)
    reference: str | None = Field(default=None, min_length=1, max_length=80)
    project_title: str | None = Field(default=None, max_length=240)
    currency: str | None = Field(default=None, min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    project_value: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    renewal_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    renewal_currency: str | None = Field(default=None, min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    renewal_due_date: date | None = None
    issue_date: date | None = None
    due_date: date | None = None
    payment_method: str | None = Field(default=None, max_length=120)
    notes: str | None = Field(default=None, max_length=5000)
    status: InvoiceStatus | None = None
    payments: list[InvoicePhaseInput] | None = Field(default=None, max_length=100)
    milestones: list[MilestoneCreate] | None = Field(default=None, max_length=100)
    client_name: str | None = Field(default=None, max_length=200)
    phone: str | None = Field(default=None, max_length=40)
    paid_amount: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)

    @field_validator("invoice_number", "reference", "due_date", "renewal_due_date", mode="before")
    @classmethod
    def blank_optional_fields_are_none(cls, value: object) -> object:
        return None if value == "" else value


class PaymentCreate(APIModel):
    milestone_id: UUID | None = None
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    currency: str = Field(default="LKR", min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    method: str | None = Field(default=None, max_length=120)
    reference: str | None = Field(default=None, max_length=240)
    paid_at: datetime
    notes: str | None = Field(default=None, max_length=2000)


class PaymentUpdate(APIModel):
    milestone_id: UUID | None = None
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    currency: str | None = Field(default=None, min_length=3, max_length=3, pattern=r"^[A-Z]{3}$")
    method: str | None = Field(default=None, max_length=120)
    reference: str | None = Field(default=None, max_length=240)
    paid_at: datetime | None = None
    notes: str | None = Field(default=None, max_length=2000)


class PaymentResponse(PaymentCreate):
    id: UUID
    invoice_id: UUID
    created_by: UUID | None = None
    created_at: datetime
    updated_at: datetime


class InvoiceResponse(APIModel):
    id: UUID
    invoice_number: str
    client_id: UUID
    agreement_id: UUID | None = None
    currency: str
    project_value: Decimal
    renewal_amount: Decimal | None = None
    renewal_currency: str | None = None
    issue_date: date
    due_date: date | None = None
    payment_method: str | None = None
    notes: str | None = None
    status: InvoiceStatus
    created_by: UUID | None = None
    created_at: datetime
    updated_at: datetime
    milestones: list[MilestoneResponse] = Field(default_factory=list)
    payments: list[PaymentResponse] = Field(default_factory=list)


class AuditLogResponse(APIModel):
    id: int
    actor_user_id: UUID | None = None
    action: str
    entity_type: str
    entity_id: str | None = None
    request_id: str | None = None
    ip_address: str | None = None
    user_agent: str | None = None
    metadata: dict[str, Any]
    created_at: datetime


class DashboardSummary(APIModel):
    clients_total: int
    active_clients: int
    agreements_total: int
    agreements_awaiting_signature: int
    agreements_signed: int
    invoices_total: int
    invoices_outstanding: int
    portfolio_projects: int
    total_invoiced: Decimal
    total_collected: Decimal
    outstanding_balance: Decimal
    currency: str
    recent_activity: list[AuditLogResponse]


class PageResponse(APIModel):
    items: list[dict[str, Any]]
    limit: int
    offset: int
    count: int


class HealthResponse(APIModel):
    status: str
    service: str
    environment: str


def json_ready(model: BaseModel, *, exclude_unset: bool = False, exclude: set[str] | None = None) -> dict[str, Any]:
    """Serialize Pydantic values for PostgREST (UUID/date/Decimal become JSON primitives)."""

    return model.model_dump(
        mode="json",
        exclude_unset=exclude_unset,
        exclude_none=True,
        exclude=exclude or set(),
    )
