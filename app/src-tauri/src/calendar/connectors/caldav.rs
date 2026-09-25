//! Bounded CalDAV discovery and synchronization with strict credential redirects.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::{header, Client, Method, StatusCode, Url};

use super::{
    CalendarConnector, ConnectorError, ConnectorErrorKind, FreeBusyRequest, FreeBusyResult,
    PushOutcome, RemoteCalendar, RemoteChange, SyncBatch,
};
use crate::calendar::domain::{CalendarOperation, OperationKind};
use crate::calendar::ical::{parse_calendar, write_calendar, ExportOptions, Limits, ParsedEvent};
use crate::store::Store;

const MAX_XML_BYTES: usize = 2 * 1024 * 1024;
const MAX_DAV_RESPONSES: usize = 10_000;
const MAX_REDIRECTS: usize = 5;

#[derive(Clone)]
pub enum Credentials {
    Basic { username: String, password: String },
    Bearer(String),
}

#[derive(Debug, Clone, Default)]
struct DavResponse {
    href: String,
    status: Option<u16>,
    properties: HashMap<String, String>,
    is_calendar: bool,
    supports_sync_collection: bool,
    supports_scheduling: bool,
    writable: bool,
}

#[derive(Debug, Clone, Default)]
struct DavDocument {
    responses: Vec<DavResponse>,
    sync_token: Option<String>,
}

fn error(kind: ConnectorErrorKind, code: &str, message: impl Into<String>) -> ConnectorError {
    ConnectorError::new(kind, code, message)
}

fn xml_text(reader: &Reader<&[u8]>, value: &[u8]) -> Result<String, ConnectorError> {
    let decoded = reader.decoder().decode(value).map_err(|_| {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-xml",
            "CalDAV XML is not valid UTF-8",
        )
    })?;
    quick_xml::escape::unescape(&decoded)
        .map(|value| value.into_owned())
        .map_err(|_| {
            error(
                ConnectorErrorKind::Permanent,
                "invalid-xml",
                "CalDAV XML contains invalid escaping",
            )
        })
}

fn local_name(value: &[u8]) -> String {
    let name = value.rsplit(|byte| *byte == b':').next().unwrap_or(value);
    String::from_utf8_lossy(name).to_ascii_lowercase()
}

fn parse_status(value: &str) -> Option<u16> {
    value
        .split_whitespace()
        .find_map(|part| part.parse::<u16>().ok())
}

fn parse_multistatus(bytes: &[u8]) -> Result<DavDocument, ConnectorError> {
    if bytes.len() > MAX_XML_BYTES {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "xml-too-large",
            "CalDAV response exceeds the supported size",
        ));
    }
    let lower = String::from_utf8_lossy(bytes).to_ascii_lowercase();
    if lower.contains("<!doctype") || lower.contains("<!entity") {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "unsafe-xml",
            "CalDAV response contains forbidden XML entities",
        ));
    }

    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut stack = Vec::<String>::new();
    let mut text = String::new();
    let mut document = DavDocument::default();
    let mut response: Option<DavResponse> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => {
                let name = local_name(start.name().as_ref());
                if name == "response" {
                    if document.responses.len() >= MAX_DAV_RESPONSES {
                        return Err(error(
                            ConnectorErrorKind::Permanent,
                            "xml-too-complex",
                            "CalDAV response contains too many resources",
                        ));
                    }
                    response = Some(DavResponse::default());
                }
                stack.push(name);
                text.clear();
            }
            Ok(Event::Empty(empty)) => {
                let name = local_name(empty.name().as_ref());
                if let Some(current) = response.as_mut() {
                    match name.as_str() {
                        "calendar" => current.is_calendar = true,
                        "sync-collection" => current.supports_sync_collection = true,
                        "schedule-inbox" | "schedule-outbox" => current.supports_scheduling = true,
                        "write" | "write-content" => current.writable = true,
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(value)) => {
                text.push_str(&xml_text(&reader, value.as_ref())?);
            }
            Ok(Event::CData(value)) => {
                text.push_str(&xml_text(&reader, value.as_ref())?);
            }
            Ok(Event::End(end)) => {
                let name = local_name(end.name().as_ref());
                let parent = stack.iter().rev().nth(1).map(String::as_str).unwrap_or("");
                let value = text.trim().to_string();
                if name == "response" {
                    if let Some(current) = response.take() {
                        document.responses.push(current);
                    }
                } else if let Some(current) = response.as_mut() {
                    if name == "href" && parent == "response" {
                        current.href = value.clone();
                    }
                    if name == "status" {
                        current.status = parse_status(&value);
                    }
                    if matches!(
                        name.as_str(),
                        "displayname"
                            | "calendar-description"
                            | "calendar-color"
                            | "calendar-timezone"
                            | "getetag"
                            | "getctag"
                            | "sync-token"
                            | "current-user-principal"
                            | "calendar-home-set"
                            | "schedule-inbox-url"
                            | "schedule-outbox-url"
                            | "calendar-data"
                    ) {
                        current.properties.insert(name.clone(), value.clone());
                    }
                    if name == "href" && parent != "response" {
                        current.properties.insert(parent.to_string(), value.clone());
                    }
                } else if name == "sync-token" && !value.is_empty() {
                    document.sync_token = Some(value.clone());
                }
                stack.pop();
                text.clear();
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(parse_error) => {
                return Err(error(
                    ConnectorErrorKind::Permanent,
                    "invalid-xml",
                    format!("CalDAV response is malformed: {parse_error}"),
                ))
            }
        }
    }
    Ok(document)
}

fn status_error(status: StatusCode, retry_after: Option<&header::HeaderValue>) -> ConnectorError {
    let (kind, code, message) = match status.as_u16() {
        401 => (
            ConnectorErrorKind::AuthRequired,
            "auth-required",
            "CalDAV credentials were rejected",
        ),
        403 => (
            ConnectorErrorKind::PermissionDenied,
            "permission-denied",
            "CalDAV access was denied",
        ),
        409 => (
            ConnectorErrorKind::Conflict,
            "remote-conflict",
            "CalDAV resource is in conflict",
        ),
        412 => (
            ConnectorErrorKind::Conflict,
            "precondition-failed",
            "CalDAV resource changed remotely",
        ),
        429 => (
            ConnectorErrorKind::RateLimited,
            "rate-limited",
            "CalDAV server is rate limiting requests",
        ),
        500..=599 => (
            ConnectorErrorKind::Transient,
            "server-error",
            "CalDAV server is temporarily unavailable",
        ),
        _ => (
            ConnectorErrorKind::Permanent,
            "dav-error",
            "CalDAV request failed",
        ),
    };
    let mut result = error(kind, code, format!("{message} ({status})"));
    result.retry_after_seconds = retry_after
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok());
    result
}

fn validated_url(raw: &str) -> Result<Url, ConnectorError> {
    let url = Url::parse(raw).map_err(|_| {
        error(
            ConnectorErrorKind::Permanent,
            "invalid-url",
            "Enter a valid CalDAV URL",
        )
    })?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(cfg!(test) && url.scheme() == "http" && loopback) {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "https-required",
            "CalDAV requires HTTPS",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
        return Err(error(
            ConnectorErrorKind::Permanent,
            "invalid-url",
            "CalDAV URL must not contain credentials",
        ));
    }
    Ok(url)
}

#[derive(Clone)]
pub struct CalDavConnector {
    base_url: Url,
    collection_url: Option<Url>,
    credentials: Credentials,
    client: Client,
    store: Option<Arc<Store>>,
}

impl CalDavConnector {
    pub fn new(url: &str, credentials: Credentials) -> Result<Self, ConnectorError> {
        Ok(Self {
            base_url: validated_url(url)?,
            collection_url: None,
            credentials,
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "client-error",
                        "CalDAV client could not be initialized",
                    )
                })?,
            store: None,
        })
    }

    pub fn for_collection(mut self, href: &str, store: Arc<Store>) -> Result<Self, ConnectorError> {
        self.collection_url = Some(self.base_url.join(href).map_err(|_| {
            error(
                ConnectorErrorKind::Permanent,
                "invalid-url",
                "Calendar collection URL is invalid",
            )
        })?);
        self.store = Some(store);
        Ok(self)
    }

    fn authorized(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.credentials {
            Credentials::Basic { username, password } => {
                builder.basic_auth(username, Some(password))
            }
            Credentials::Bearer(token) => builder.bearer_auth(token),
        }
    }

    async fn send(
        &self,
        method: Method,
        mut url: Url,
        depth: Option<&str>,
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
        conditional: Option<(&str, &str)>,
    ) -> Result<reqwest::Response, ConnectorError> {
        let original_origin = url.origin().ascii_serialization();
        for redirect in 0..=MAX_REDIRECTS {
            let mut request = self.client.request(method.clone(), url.clone());
            request = self.authorized(request);
            if let Some(depth) = depth {
                request = request.header("Depth", depth);
            }
            if let Some(content_type) = content_type {
                request = request.header(header::CONTENT_TYPE, content_type);
            }
            if let Some((name, value)) = conditional {
                request = request.header(name, value);
            }
            if let Some(body) = &body {
                request = request.body(body.clone());
            }
            let response = request.send().await.map_err(|_| {
                error(
                    ConnectorErrorKind::Transient,
                    "network-error",
                    "CalDAV server could not be reached",
                )
            })?;
            if response.status().is_redirection() {
                if redirect == MAX_REDIRECTS {
                    return Err(error(
                        ConnectorErrorKind::Permanent,
                        "too-many-redirects",
                        "CalDAV redirected too many times",
                    ));
                }
                let location = response
                    .headers()
                    .get(header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or_else(|| {
                        error(
                            ConnectorErrorKind::Permanent,
                            "invalid-redirect",
                            "CalDAV redirect has no valid location",
                        )
                    })?;
                let next = url.join(location).map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-redirect",
                        "CalDAV redirect is invalid",
                    )
                })?;
                if next.origin().ascii_serialization() != original_origin {
                    return Err(error(
                        ConnectorErrorKind::Permanent,
                        "cross-origin-authorization",
                        "CalDAV credentials were not forwarded to another origin",
                    ));
                }
                url = next;
                continue;
            }
            if !response.status().is_success() && response.status() != StatusCode::MULTI_STATUS {
                return Err(status_error(
                    response.status(),
                    response.headers().get(header::RETRY_AFTER),
                ));
            }
            return Ok(response);
        }
        unreachable!()
    }

    async fn dav_xml(
        &self,
        method: Method,
        url: Url,
        depth: &str,
        body: &str,
    ) -> Result<DavDocument, ConnectorError> {
        let response = self
            .send(
                method,
                url,
                Some(depth),
                Some(body.as_bytes().to_vec()),
                Some("application/xml; charset=utf-8"),
                None,
            )
            .await?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_XML_BYTES as u64)
        {
            return Err(error(
                ConnectorErrorKind::Permanent,
                "xml-too-large",
                "CalDAV response exceeds the supported size",
            ));
        }
        let bytes = response.bytes().await.map_err(|_| {
            error(
                ConnectorErrorKind::Transient,
                "network-error",
                "CalDAV response could not be read",
            )
        })?;
        parse_multistatus(&bytes)
    }

    async fn collection_discovery(&self, url: Url) -> Result<Vec<RemoteCalendar>, ConnectorError> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"><d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/><d:supported-report-set/><d:sync-token/><cs:getctag/><c:calendar-description/><c:calendar-color/><c:calendar-timezone/><c:schedule-calendar-transp/></d:prop></d:propfind>"#;
        let document = self
            .dav_xml(
                Method::from_bytes(b"PROPFIND").unwrap(),
                url.clone(),
                "1",
                body,
            )
            .await?;
        document
            .responses
            .into_iter()
            .filter(|response| response.is_calendar)
            .map(|response| {
                let absolute = url.join(&response.href).map_err(|_| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "invalid-url",
                        "Server returned an invalid calendar URL",
                    )
                })?;
                Ok(RemoteCalendar {
                    id: absolute.as_str().to_string(),
                    href: absolute.as_str().to_string(),
                    name: response
                        .properties
                        .get("displayname")
                        .cloned()
                        .filter(|value| !value.is_empty())
                        .unwrap_or_else(|| "Calendar".into()),
                    description: response
                        .properties
                        .get("calendar-description")
                        .cloned()
                        .unwrap_or_default(),
                    color: response
                        .properties
                        .get("calendar-color")
                        .cloned()
                        .filter(|value| value.starts_with('#'))
                        .unwrap_or_else(|| "#6f8df6".into()),
                    timezone: response
                        .properties
                        .get("calendar-timezone")
                        .cloned()
                        .filter(|value| value.contains('/'))
                        .unwrap_or_else(|| "UTC".into()),
                    writable: response.writable,
                    supports_sync_collection: response.supports_sync_collection,
                    supports_scheduling: response.supports_scheduling,
                    ctag: response.properties.get("getctag").cloned(),
                    sync_token: response.properties.get("sync-token").cloned(),
                })
            })
            .collect()
    }

    async fn discover_from(&self, url: Url) -> Result<Vec<RemoteCalendar>, ConnectorError> {
        let root_body = r#"<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:current-user-principal/><c:calendar-home-set/><c:schedule-inbox-URL/><c:schedule-outbox-URL/></d:prop></d:propfind>"#;
        let root = self
            .dav_xml(
                Method::from_bytes(b"PROPFIND").unwrap(),
                url.clone(),
                "0",
                root_body,
            )
            .await?;
        let properties = root.responses.first().map(|response| &response.properties);
        let principal_href =
            properties.and_then(|properties| properties.get("current-user-principal"));
        let direct_home = properties.and_then(|properties| properties.get("calendar-home-set"));
        let home = if let Some(home) = direct_home {
            url.join(home).map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-url",
                    "Server returned an invalid calendar home URL",
                )
            })?
        } else if let Some(principal) = principal_href {
            let principal = url.join(principal).map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-url",
                    "Server returned an invalid principal URL",
                )
            })?;
            let principal_document = self
                .dav_xml(
                    Method::from_bytes(b"PROPFIND").unwrap(),
                    principal.clone(),
                    "0",
                    root_body,
                )
                .await?;
            let home = principal_document
                .responses
                .first()
                .and_then(|response| response.properties.get("calendar-home-set"))
                .ok_or_else(|| {
                    error(
                        ConnectorErrorKind::Permanent,
                        "calendar-home-missing",
                        "CalDAV server did not advertise a calendar home",
                    )
                })?;
            principal.join(home).map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-url",
                    "Server returned an invalid calendar home URL",
                )
            })?
        } else {
            url
        };
        self.collection_discovery(home).await
    }
}

#[async_trait]
impl CalendarConnector for CalDavConnector {
    async fn discover(&self) -> Result<Vec<RemoteCalendar>, ConnectorError> {
        let mut well_known = self.base_url.clone();
        well_known.set_path("/.well-known/caldav");
        well_known.set_query(None);
        well_known.set_fragment(None);
        match self.discover_from(well_known).await {
            Ok(calendars) if !calendars.is_empty() => Ok(calendars),
            Err(error) if error.code == "cross-origin-authorization" => Err(error),
            _ => self.discover_from(self.base_url.clone()).await,
        }
    }

    async fn pull(&self, cursor: Option<&str>) -> Result<SyncBatch, ConnectorError> {
        let url = self.collection_url.clone().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "calendar-not-selected",
                "No CalDAV calendar collection is selected",
            )
        })?;
        let (body, depth) = if let Some(cursor) = cursor {
            (
                format!(
                    r#"<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>{}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/><c:calendar-data xmlns:c="urn:ietf:params:xml:ns:caldav"/></d:prop></d:sync-collection>"#,
                    xml_escape(cursor)
                ),
                "1",
            )
        } else {
            (r#"<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>"#.into(), "1")
        };
        let document = self
            .dav_xml(Method::from_bytes(b"REPORT").unwrap(), url, depth, &body)
            .await?;
        let mut changes = Vec::new();
        for response in document.responses {
            if response.status == Some(404) {
                changes.push(RemoteChange::Delete {
                    href: response.href,
                });
                continue;
            }
            let Some(calendar_data) = response.properties.get("calendar-data") else {
                continue;
            };
            let parsed =
                parse_calendar(calendar_data.as_bytes(), Limits::default()).map_err(|value| {
                    error(ConnectorErrorKind::Permanent, value.code(), value.message())
                })?;
            for parsed_event in parsed.events {
                changes.push(RemoteChange::Upsert {
                    href: response.href.clone(),
                    etag: response.properties.get("getetag").cloned(),
                    event: parsed_event.event,
                });
            }
        }
        Ok(SyncBatch {
            changes,
            next_cursor: document.sync_token.or_else(|| cursor.map(str::to_string)),
            ctag: None,
        })
    }

    async fn push(&self, operation: &CalendarOperation) -> Result<PushOutcome, ConnectorError> {
        let store = self.store.as_ref().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "store-unavailable",
                "Calendar store is unavailable",
            )
        })?;
        let event = store
            .calendar_event(&operation.event_id)
            .map_err(|_| {
                error(
                    ConnectorErrorKind::Transient,
                    "storage-error",
                    "Calendar event could not be loaded",
                )
            })?
            .ok_or_else(|| {
                error(
                    ConnectorErrorKind::Permanent,
                    "event-not-found",
                    "Calendar event was not found",
                )
            })?;
        let collection = self.collection_url.clone().ok_or_else(|| {
            error(
                ConnectorErrorKind::Permanent,
                "calendar-not-selected",
                "No CalDAV calendar collection is selected",
            )
        })?;
        let href = event
            .provider_id
            .as_deref()
            .map(|value| collection.join(value))
            .transpose()
            .map_err(|_| {
                error(
                    ConnectorErrorKind::Permanent,
                    "invalid-url",
                    "Stored CalDAV event URL is invalid",
                )
            })?
            .unwrap_or_else(|| {
                collection
                    .join(&format!("{}.ics", urlencoding::encode(&event.uid)))
                    .unwrap()
            });
        let conditional = match operation.kind {
            OperationKind::Create => Some((header::IF_NONE_MATCH.as_str(), "*")),
            OperationKind::Update | OperationKind::Delete => operation
                .expected_provider_version
                .as_deref()
                .map(|etag| (header::IF_MATCH.as_str(), etag)),
            OperationKind::SendInvitation => None,
        };
        let method = if operation.kind == OperationKind::Delete {
            Method::DELETE
        } else {
            Method::PUT
        };
        let body = if method == Method::PUT {
            Some(
                write_calendar(
                    &[ParsedEvent {
                        event,
                        preserved_properties: Vec::new(),
                    }],
                    ExportOptions::default(),
                )
                .map_err(|value| {
                    error(ConnectorErrorKind::Permanent, value.code(), value.message())
                })?,
            )
        } else {
            None
        };
        let response = self
            .send(
                method,
                href.clone(),
                None,
                body,
                Some("text/calendar; charset=utf-8"),
                conditional,
            )
            .await?;
        Ok(PushOutcome {
            href: Some(href.to_string()),
            provider_version: response
                .headers()
                .get(header::ETAG)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
        })
    }

    async fn free_busy(
        &self,
        _request: &FreeBusyRequest,
    ) -> Result<FreeBusyResult, ConnectorError> {
        Ok(FreeBusyResult {
            intervals: Vec::new(),
            complete: false,
        })
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::connectors::test_server::TestServer;

    fn credentials() -> Credentials {
        Credentials::Basic {
            username: "calendar-user".into(),
            password: "secret".into(),
        }
    }

    #[tokio::test]
    async fn discovery_never_forwards_basic_auth_across_origins() {
        let destination = TestServer::once(207, Vec::new(), "<d:multistatus xmlns:d=\"DAV:\"/>");
        let first = TestServer::once(302, vec![("Location", destination.url().to_string())], "");
        let connector = CalDavConnector::new(first.url(), credentials()).unwrap();
        let result = connector.discover().await;
        assert_eq!(result.unwrap_err().code(), "cross-origin-authorization");
        assert_eq!(destination.authorization(), None);
    }

    #[test]
    fn rejects_xml_entities_and_oversized_multistatus() {
        assert_eq!(
            parse_multistatus(
                b"<!DOCTYPE x [<!ENTITY xxe SYSTEM 'file:///etc/passwd'>]><multistatus/>"
            )
            .unwrap_err()
            .code(),
            "unsafe-xml"
        );
        assert_eq!(
            parse_multistatus(&vec![b' '; MAX_XML_BYTES + 1])
                .unwrap_err()
                .code(),
            "xml-too-large"
        );
    }

    #[test]
    fn parses_collection_capabilities_without_exposing_credentials() {
        let document = parse_multistatus(br#"<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:write/></d:privilege></d:current-user-privilege-set><d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set><d:sync-token>token-1</d:sync-token></d:prop></d:propstat></d:response></d:multistatus>"#).unwrap();
        assert_eq!(document.responses.len(), 1);
        assert!(document.responses[0].is_calendar);
        assert!(document.responses[0].writable);
        assert!(document.responses[0].supports_sync_collection);
        assert_eq!(
            document.responses[0]
                .properties
                .get("sync-token")
                .map(String::as_str),
            Some("token-1")
        );
    }
}
