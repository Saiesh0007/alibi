"""Turn a verdict into a smaller token instead of switching the agent off."""
from urllib.parse import urlparse


def scope_for(ev):
    tool, target = ev["tool"], ev.get("target", "")
    if tool == "http_post":
        host = urlparse(target).hostname or ""
        return "net:internal" if host.endswith(".internal") else "net:external"
    if tool == "send_email":
        return "mail:send"
    if tool == "create_purchase_request":
        return "erp:purchase_request"
    if "/" in target:
        return target.split("/")[0] + ":read"
    return tool


def respond(token_scopes, verdict, ev):
    """Returns (new_scopes, note)."""
    scopes = list(token_scopes)
    if verdict.action == "ALLOW":
        return scopes, "allowed"
    if verdict.action == "HOLD":
        return scopes, "paused, waiting for the owner to approve this one action"
    if verdict.action == "QUARANTINE":
        return [], "all scopes revoked, token rotated, owner paged"
    drop = {scope_for(ev), "net:external"}
    return [x for x in scopes if x not in drop], f"blocked; removed {', '.join(sorted(drop & set(scopes)))}"
