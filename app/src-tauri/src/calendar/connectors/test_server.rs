//! Minimal deterministic HTTP server used by connector security tests.

use std::sync::{Arc, Mutex};
use std::thread;

use tiny_http::{Header, Response, Server, StatusCode};

pub struct TestServer {
    url: String,
    authorization: Arc<Mutex<Option<String>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl TestServer {
    pub fn once(
        status: u16,
        headers: Vec<(&'static str, String)>,
        body: impl Into<String>,
    ) -> Self {
        let server = Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let authorization = Arc::new(Mutex::new(None));
        let captured = authorization.clone();
        let body = body.into();
        let handle = thread::spawn(move || {
            if let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_secs(2)) {
                *captured.lock().unwrap() = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("authorization"))
                    .map(|header| header.value.as_str().to_string());
                let mut response = Response::from_string(body).with_status_code(StatusCode(status));
                for (name, value) in headers {
                    response = response.with_header(Header::from_bytes(name, value).unwrap());
                }
                let _ = request.respond(response);
            }
        });
        Self {
            url,
            authorization,
            handle: Some(handle),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn authorization(&self) -> Option<String> {
        self.authorization.lock().unwrap().clone()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

pub struct ResponseSpec {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

pub struct ScriptedServer {
    url: String,
    paths: Arc<Mutex<Vec<String>>>,
    handle: Option<thread::JoinHandle<()>>,
}

impl ScriptedServer {
    pub fn new(responses: Vec<ResponseSpec>) -> Self {
        let server = Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.server_addr());
        let paths = Arc::new(Mutex::new(Vec::new()));
        let captured = paths.clone();
        let handle = thread::spawn(move || {
            for spec in responses {
                let Ok(Some(request)) = server.recv_timeout(std::time::Duration::from_secs(2))
                else {
                    break;
                };
                captured.lock().unwrap().push(request.url().to_string());
                let mut response =
                    Response::from_string(spec.body).with_status_code(StatusCode(spec.status));
                for (name, value) in spec.headers {
                    response = response.with_header(Header::from_bytes(name, value).unwrap());
                }
                let _ = request.respond(response);
            }
        });
        Self {
            url,
            paths,
            handle: Some(handle),
        }
    }

    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn paths(&self) -> Vec<String> {
        self.paths.lock().unwrap().clone()
    }
}

impl Drop for ScriptedServer {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
