"""
AD Bridge API - LDAP Client

Encapsulates the LDAP connection and operations.
"""

import ssl
from datetime import datetime, timezone
from typing import Any

import ldap3
from ldap3 import ALL_ATTRIBUTES, Connection, Server, Tls

from config import (
    AD_BASE_DN,
    AD_BIND_PASSWORD,
    AD_BIND_USER,
    AD_CERT_FILE,
    AD_SERVER,
    AD_USE_TLS,
    GROUP_ATTRIBUTES,
    LDAP_TIMEOUT,
    USER_ATTRIBUTES,
)


def _create_server() -> Server:
    """Creates an LDAP server with optional TLS configuration."""
    tls_config = None

    if AD_USE_TLS or AD_SERVER.startswith("ldaps://"):
        tls_config = Tls(
            validate=ssl.CERT_REQUIRED if AD_CERT_FILE else ssl.CERT_NONE,
            ca_certs_file=AD_CERT_FILE if AD_CERT_FILE else None,
        )

    return Server(
        AD_SERVER,
        get_info=ldap3.ALL,
        tls=tls_config,
        connect_timeout=LDAP_TIMEOUT,
    )


def _get_connection() -> Connection:
    """Creates an authenticated LDAP connection."""
    server = _create_server()
    conn = Connection(
        server,
        user=AD_BIND_USER,
        password=AD_BIND_PASSWORD,
        auto_bind=True,
        receive_timeout=LDAP_TIMEOUT,
    )
    return conn


def _convert_ad_timestamp(value: Any) -> str | None:
    """Converts AD timestamps to ISO 8601."""
    if value is None:
        return None

    # Windows FileTime (100-ns intervals since 1601-01-01)
    if isinstance(value, int) and value > 0:
        # 0 and 9223372036854775807 mean "never".
        if value == 0 or value == 9223372036854775807:
            return None
        try:
            # Convert FileTime to Unix epoch.
            unix_ts = (value - 116444736000000000) / 10000000
            dt = datetime.fromtimestamp(unix_ts, tz=timezone.utc)
            return dt.isoformat()
        except (ValueError, OSError):
            return None

    # Already a datetime.
    if isinstance(value, datetime):
        return value.isoformat()

    # AD generalized time (YYYYMMDDHHmmss.0Z).
    if isinstance(value, str) and len(value) >= 14:
        try:
            dt = datetime.strptime(value[:14], "%Y%m%d%H%M%S")
            return dt.replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass

    return str(value)


def _format_entry(entry: ldap3.Entry) -> dict[str, Any]:
    """Formats an LDAP entry as a dictionary."""
    result: dict[str, Any] = {}

    for attr_name in entry.entry_attributes:
        value = entry[attr_name].value

        # Single value vs. list.
        if isinstance(value, list) and len(value) == 1:
            value = value[0]

        # Convert timestamps.
        if attr_name in ("lastLogon", "lastLogonTimestamp", "accountExpires", "pwdLastSet"):
            value = _convert_ad_timestamp(value)
        elif attr_name in ("whenCreated", "whenChanged"):
            value = _convert_ad_timestamp(value)

        # Interpret userAccountControl.
        if attr_name == "userAccountControl" and isinstance(value, int):
            # Bit 2 = ACCOUNTDISABLE
            result["enabled"] = not bool(value & 0x2)

        # Bytes to string.
        if isinstance(value, bytes):
            try:
                value = value.decode("utf-8")
            except UnicodeDecodeError:
                # Binary data (for example objectSid) as hex.
                value = value.hex()

        result[attr_name] = value

    return result


def search_users(
    ldap_filter: str | None = None,
    attributes: list[str] | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """
    Searches users in Active Directory.

    Args:
        ldap_filter: LDAP filter (for example "(department=IT)")
        attributes: List of attributes (default: USER_ATTRIBUTES)
        limit: Maximum number of results

    Returns:
        List of user dictionaries
    """
    # Default filter: users only (no computers, etc.).
    base_filter = "(&(objectClass=user)(objectCategory=person))"

    if ldap_filter:
        # Combine filters.
        search_filter = f"(&{base_filter}{ldap_filter})"
    else:
        search_filter = base_filter

    attrs = attributes or USER_ATTRIBUTES

    with _get_connection() as conn:
        conn.search(
            search_base=AD_BASE_DN,
            search_filter=search_filter,
            search_scope=ldap3.SUBTREE,
            attributes=attrs,
            size_limit=limit,
        )

        return [_format_entry(entry) for entry in conn.entries]


def get_user(sam_account_name: str) -> dict[str, Any] | None:
    """
    Gets a single user.

    Args:
        sam_account_name: The user's sAMAccountName

    Returns:
        User dictionary or None
    """
    ldap_filter = f"(sAMAccountName={ldap3.utils.conv.escape_filter_chars(sam_account_name)})"

    with _get_connection() as conn:
        conn.search(
            search_base=AD_BASE_DN,
            search_filter=f"(&(objectClass=user)(objectCategory=person){ldap_filter})",
            search_scope=ldap3.SUBTREE,
            attributes=USER_ATTRIBUTES,
            size_limit=1,
        )

        if conn.entries:
            return _format_entry(conn.entries[0])

    return None


def search_groups(
    ldap_filter: str | None = None,
    attributes: list[str] | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    """
    Searches groups in Active Directory.

    Args:
        ldap_filter: LDAP filter
        attributes: List of attributes
        limit: Maximum number of results

    Returns:
        List of group dictionaries
    """
    base_filter = "(objectClass=group)"

    if ldap_filter:
        search_filter = f"(&{base_filter}{ldap_filter})"
    else:
        search_filter = base_filter

    attrs = attributes or GROUP_ATTRIBUTES

    with _get_connection() as conn:
        conn.search(
            search_base=AD_BASE_DN,
            search_filter=search_filter,
            search_scope=ldap3.SUBTREE,
            attributes=attrs,
            size_limit=limit,
        )

        return [_format_entry(entry) for entry in conn.entries]


def get_group_members(group_cn: str) -> dict[str, Any] | None:
    """
    Gets a group with its members.

    Args:
        group_cn: The group's CN (Common Name)

    Returns:
        Group dictionary with members, or None
    """
    ldap_filter = f"(cn={ldap3.utils.conv.escape_filter_chars(group_cn)})"

    with _get_connection() as conn:
        # Get the group.
        conn.search(
            search_base=AD_BASE_DN,
            search_filter=f"(&(objectClass=group){ldap_filter})",
            search_scope=ldap3.SUBTREE,
            attributes=GROUP_ATTRIBUTES,
            size_limit=1,
        )

        if not conn.entries:
            return None

        group = _format_entry(conn.entries[0])

        # Resolve members.
        members_dns = group.get("member", [])
        if isinstance(members_dns, str):
            members_dns = [members_dns]

        members = []
        for member_dn in members_dns:
            # Get member details (basic info only).
            conn.search(
                search_base=member_dn,
                search_filter="(objectClass=*)",
                search_scope=ldap3.BASE,
                attributes=["sAMAccountName", "displayName", "mail", "objectClass"],
            )

            if conn.entries:
                member = _format_entry(conn.entries[0])
                # Users only, no nested groups.
                if "person" in str(member.get("objectClass", [])).lower():
                    members.append({
                        "samAccountName": member.get("sAMAccountName"),
                        "displayName": member.get("displayName"),
                        "email": member.get("mail"),
                    })

        group["members"] = members
        del group["member"]  # Remove raw DNs.

        return group

