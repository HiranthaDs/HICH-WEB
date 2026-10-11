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
        title = lines.pop(0) if heading else ""
        is_summary = bool(re.search(r"(?:INVOICE|RENEWAL) (?:SUMMARY|DETAILS)", title))
        is_action = title.startswith(("OPEN", "VIEW")) and any(line.startswith("https://") for line in lines)
        if is_action:
            url = next(line for line in lines if line.startswith("https://"))
            label = re.sub(r"^(?:OPEN|VIEW)", "View", title, count=1).capitalize()
            sections.append(f'<div style="margin:4px 0 18px"><a href="{escape(url)}" style="display:inline-block;background:#5263ff;color:#fff;text-decoration:none;font-weight:700;font-size:13px;padding:12px 18px;border-radius:9px">{escape(label)}</a></div>')
            continue
        if is_summary:
            rows = []
            for line in lines:
                label, separator, value = line.partition(":")
                if not separator:
                    label, value = "", line
                highlight = bool(re.search(r"balance due|invoice total|remaining balance", label, re.I))
                weight, color = ("700", "#1e2fc5") if highlight else ("600", "#243149")
                rows.append(f'<tr><td style="padding:5px 10px 5px 0;color:#738098;font-size:12px">{escape(label)}</td><td style="padding:5px 0;text-align:right;font-size:12px;font-weight:{weight};color:{color}">{escape(value.strip())}</td></tr>')
            sections.append(f'<div style="margin:0 0 16px;background:#f6f7fb;border:1px solid #e4e8f1;border-radius:11px;padding:15px 17px"><h2 style="font-size:10px;letter-spacing:1.2px;color:#5263ff;margin:0 0 7px">{escape(title)}</h2><table role="presentation" width="100%" cellspacing="0" cellpadding="0">{"".join(rows)}</table></div>')
            continue
        content = []
        for line in lines:
            safe = escape(line)
            content.append(f'<a href="{safe}" style="color:#2535dc;word-break:break-all">{safe}</a>' if line.startswith("https://") else safe)
        style = "border-left:3px solid #d8ddff;padding:2px 0 2px 14px;" if heading else ""
        heading_html = f'<h2 style="font-size:10px;letter-spacing:1.1px;color:#5263ff;margin:0 0 7px">{escape(title)}</h2>' if heading else ""
        sections.append(f'<div style="margin:0 0 16px;{style}">{heading_html}' + "<br>".join(content) + "</div>")
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(subject) + '</title></head><body style="margin:0;background:#f2f4f8;font-family:Arial,sans-serif;color:#243149"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:20px 10px"><table role="presentation" width="100%" style="max-width:600px;margin:auto;background:#fff;border:1px solid #e4e8f1;border-radius:14px;overflow:hidden" cellspacing="0" cellpadding="0"><tr><td style="background:#192a46;color:#fff;padding:20px 24px"><strong style="font-size:20px;letter-spacing:1.6px">HICH WEB</strong><span style="float:right;font-size:10px;color:#c8d5e8;padding-top:5px">WEBSITES &amp; SYSTEMS</span></td></tr><tr><td style="padding:24px;font-size:13px;line-height:1.6"><h1 style="font-size:18px;line-height:1.35;margin:0 0 20px;color:#17243a">' + escape(subject) + '</h1>' + "".join(sections) + '</td></tr><tr><td style="padding:16px 24px;border-top:1px solid #edf0f6;font-size:10px;line-height:1.6;color:#758198">Hich Web · Clear scope. Recorded payments. Reliable service.<br>Keep private document links secure.</td></tr></table></td></tr></table></body></html>'


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
