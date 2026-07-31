"""
AD Bridge API - REST endpoints

A simple REST API that runs LDAP queries against Active Directory.
Called by Edge Connector, not directly from outside.
"""

import importlib.util
import logging
import os
from functools import wraps
from pathlib import Path
from types import ModuleType
from typing import Any, Callable
from flask import Flask, jsonify, request
from config import BRIDGE_API_TOKEN, DEFAULT_LIMIT, MAX_RESULTS


def load_local_module(module_name: str, file_name: str) -> ModuleType:
    module_path = Path(__file__).with_name(file_name)
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load {file_name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ldap_client = load_local_module("ldap_client", "ldap-client.py")

# Configure logging.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("ad-bridge")

app = Flask(__name__)


# =============================================================================
# Authentication
# =============================================================================


def require_auth(f: Callable) -> Callable:
    """Decorator for API authentication."""

    @wraps(f)
    def decorated(*args: Any, **kwargs: Any) -> Any:
        auth_header = request.headers.get("Authorization", "")

        if not auth_header.startswith("Bearer "):
            return jsonify({"error": "Missing or invalid Authorization header"}), 401

        token = auth_header[7:]  # Remove "Bearer ".

        if not BRIDGE_API_TOKEN:
            logger.warning("BRIDGE_API_TOKEN not configured, skipping auth")
        elif token != BRIDGE_API_TOKEN:
            return jsonify({"error": "Invalid token"}), 401

        return f(*args, **kwargs)

    return decorated


# =============================================================================
# Health-Endpoints
# =============================================================================


@app.route("/health")
def health() -> tuple[Any, int]:
    """Health check without authentication."""
    return jsonify({"status": "ok"}), 200


@app.route("/ready")
def ready() -> tuple[Any, int]:
    """Readiness check with an LDAP connection test."""
    try:
        # Simple LDAP search as a connection test.
        ldap_client.search_users(limit=1)
        return jsonify({"status": "ok", "ldap": "connected"}), 200
    except Exception as e:
        logger.error(f"LDAP connection failed: {e}")
        return jsonify({"status": "error", "ldap": str(e)}), 503


# =============================================================================
# User-Endpoints
# =============================================================================


@app.route("/api/users")
@require_auth
def list_users() -> tuple[Any, int]:
    """
    Lists users.

    Query parameters:
        filter: LDAP filter (for example "(department=IT)")
        attributes: Comma-separated attributes
        limit: Maximum number of results (default: 100, max: 1000)
    """
    request_id = request.headers.get("X-Request-Id", "-")
    logger.info(f"[{request_id}] GET /api/users")

    ldap_filter = request.args.get("filter")
    attributes_param = request.args.get("attributes")
    limit = min(int(request.args.get("limit", DEFAULT_LIMIT)), MAX_RESULTS)

    attributes = None
    if attributes_param:
        attributes = [a.strip() for a in attributes_param.split(",")]

    try:
        users = ldap_client.search_users(
            ldap_filter=ldap_filter,
            attributes=attributes,
            limit=limit,
        )
        logger.info(f"[{request_id}] Found {len(users)} users")
        return jsonify(users), 200

    except Exception as e:
        logger.error(f"[{request_id}] LDAP search failed: {e}")
        return jsonify({"error": "LDAP search failed", "details": str(e)}), 500


@app.route("/api/users/<sam_account_name>")
@require_auth
def get_user(sam_account_name: str) -> tuple[Any, int]:
    """Gets a single user."""
    request_id = request.headers.get("X-Request-Id", "-")
    logger.info(f"[{request_id}] GET /api/users/{sam_account_name}")

    try:
        user = ldap_client.get_user(sam_account_name)

        if user:
            return jsonify(user), 200
        else:
            return jsonify({"error": "User not found"}), 404

    except Exception as e:
        logger.error(f"[{request_id}] LDAP search failed: {e}")
        return jsonify({"error": "LDAP search failed", "details": str(e)}), 500


# =============================================================================
# Group-Endpoints
# =============================================================================


@app.route("/api/groups")
@require_auth
def list_groups() -> tuple[Any, int]:
    """Lists groups."""
    request_id = request.headers.get("X-Request-Id", "-")
    logger.info(f"[{request_id}] GET /api/groups")

    ldap_filter = request.args.get("filter")
    attributes_param = request.args.get("attributes")
    limit = min(int(request.args.get("limit", DEFAULT_LIMIT)), MAX_RESULTS)

    attributes = None
    if attributes_param:
        attributes = [a.strip() for a in attributes_param.split(",")]

    try:
        groups = ldap_client.search_groups(
            ldap_filter=ldap_filter,
            attributes=attributes,
            limit=limit,
        )
        logger.info(f"[{request_id}] Found {len(groups)} groups")
        return jsonify(groups), 200

    except Exception as e:
        logger.error(f"[{request_id}] LDAP search failed: {e}")
        return jsonify({"error": "LDAP search failed", "details": str(e)}), 500


@app.route("/api/groups/<group_cn>")
@require_auth
def get_group(group_cn: str) -> tuple[Any, int]:
    """Gets a group with its members."""
    request_id = request.headers.get("X-Request-Id", "-")
    logger.info(f"[{request_id}] GET /api/groups/{group_cn}")

    try:
        group = ldap_client.get_group_members(group_cn)

        if group:
            return jsonify(group), 200
        else:
            return jsonify({"error": "Group not found"}), 404

    except Exception as e:
        logger.error(f"[{request_id}] LDAP search failed: {e}")
        return jsonify({"error": "LDAP search failed", "details": str(e)}), 500


# =============================================================================
# Main
# =============================================================================

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("DEBUG", "false").lower() == "true"

    logger.info(f"Starting AD Bridge API on port {port}")
    app.run(host="0.0.0.0", port=port, debug=debug)
