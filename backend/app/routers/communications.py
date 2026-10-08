"""Optional SMTP delivery. Drafts remain usable without email service credentials."""
import logging
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from html import escape

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field, TypeAdapter

from ..config import Settings, get_settings
from ..dependencies import Principal, current_admin
from ..security import enforce_rate_limit
from ..supabase_client import SupabaseGateway, get_supabase
from ..data import audit

router = APIRouter(prefix="/communications", tags=["communications"])
logger = logging.getLogger(__name__)


class EmailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    to: EmailStr
    subject: str = Field(min_length=1, max_length=200, pattern=r"^[^\r\n]+$")
    body: str = Field(min_length=1, max_length=30000)


def professional_html(subject: str, body: str) -> str:
    sections = []
    for block in re.split(r"\n\n+", body):
        lines = block.splitlines()
        if not lines:
            continue
        heading = bool(re.fullmatch(r"[A-Z &/—-]{5,}", lines[0]))
        content = []
        for index, line in enumerate(lines):
            safe = escape(line)
            if heading and index == 0:
                content.append(f'<h2 style="font-size:12px;color:#5263ff;letter-spacing:1px">{safe}</h2>')
            elif line.startswith("https://"):
                content.append(f'<a href="{safe}" style="color:#2535dc;word-break:break-all">{safe}</a>')
            else:
                content.append(safe)
        style = "background:#f4f6fc;border:1px solid #e5e9f3;border-radius:10px;padding:20px;" if heading else ""
        sections.append(f'<div style="margin:0 0 20px;{style}">' + "<br>".join(content) + "</div>")
    return '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f1f4fa;font-family:Arial,sans-serif;color:#243149"><table role="presentation" width="100%"><tr><td style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:640px;margin:auto;background:white;border-radius:16px" cellspacing="0" cellpadding="0"><tr><td style="background:#192a46;color:white;padding:28px;border-radius:16px 16px 0 0"><strong style="font-size:25px;letter-spacing:2px">HICH WEB</strong><p style="font-size:12px;color:#c0cee6">Client Services · Websites & Systems</p></td></tr><tr><td style="padding:30px 28px;font-size:14px;line-height:1.7"><h1 style="font-size:21px">' + escape(subject) + '</h1>' + "".join(sections) + '</td></tr><tr><td style="padding:22px 28px;border-top:1px solid #edf0f6;font-size:12px;color:#68778f">Hich Web | Please keep private document links secure.</td></tr></table></td></tr></table></body></html>'


def email_ready(settings: Settings) -> bool:
    return bool(settings.smtp_host and settings.smtp_username and settings.smtp_password.get_secret_value() and settings.smtp_from_email)


@router.get("/email-status")
def email_status(_: Principal = Depends(current_admin), settings: Settings = Depends(get_settings)):
    return {"available": email_ready(settings), "sender": settings.smtp_from_email if email_ready(settings) else None}


@router.post("/email")
def send_email(payload: EmailRequest, request: Request, principal: Principal = Depends(current_admin),
               settings: Settings = Depends(get_settings), gateway: SupabaseGateway = Depends(get_supabase)):
    if not email_ready(settings):
        raise HTTPException(503, "Email delivery is not configured. Download the professional email draft or use your email app.")
    enforce_rate_limit(f"client-email:{principal.id}", 10, 900)
    message = EmailMessage()
    try:
        message["From"] = formataddr((settings.smtp_from_name, str(TypeAdapter(EmailStr).validate_python(settings.smtp_from_email))))
        message["To"] = str(payload.to)
        message["Subject"] = payload.subject
        message.set_content(payload.body)
        message.add_alternative(professional_html(payload.subject, payload.body), subtype="html")
        context = ssl.create_default_context()
        smtp_class = smtplib.SMTP_SSL if settings.smtp_ssl else smtplib.SMTP
        kwargs = {"context": context} if settings.smtp_ssl else {}
        with smtp_class(settings.smtp_host, settings.smtp_port, timeout=20, **kwargs) as smtp:
            if not settings.smtp_ssl:
                smtp.ehlo(); smtp.starttls(context=context); smtp.ehlo()
            smtp.login(settings.smtp_username, settings.smtp_password.get_secret_value())
            smtp.send_message(message)
    except Exception as exc:
        logger.warning("Client email delivery did not confirm acceptance (%s)", type(exc).__name__)
        raise HTTPException(502, "Email delivery could not be confirmed. Check the sent record with your email provider before retrying to avoid a duplicate.") from exc
    audit(gateway.service, request, settings, "client_email_sent", "communication", actor=principal, metadata={"recipient": str(payload.to), "subject": payload.subject})
    return {"message": "The email provider accepted the professional email for delivery."}
