use iii_sdk::iii::III;
use iii_sdk::error::IIIError;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

mod types;

use types::{ChainRequest, FindByCapabilityRequest, HierarchyNode, SetHierarchyRequest, TreeNode, TreeRequest};

fn scope(realm_id: &str) -> String {
    format!("realm:{realm_id}:hierarchy")
}

async fn set_node(iii: &III, req: SetHierarchyRequest) -> Result<Value, IIIError> {
    let node = HierarchyNode {
        agent_id: req.agent_id.clone(),
        realm_id: req.realm_id.clone(),
        reports_to: req.reports_to,
        title: req.title,
        capabilities: req.capabilities.unwrap_or_default(),
        rank: req.rank.unwrap_or(0),
    };

    if let Some(ref parent) = node.reports_to {
        if parent == &node.agent_id {
            return Err(IIIError::Handler("agent cannot report to itself".into()));
        }

        let all_nodes = load_all(iii, &req.realm_id).await?;
        if would_create_cycle(&all_nodes, &node.agent_id, parent) {
            return Err(IIIError::Handler("cycle detected in hierarchy".into()));
        }
    }

    let value = serde_json::to_value(&node).map_err(|e| IIIError::Handler(e.to_string()))?;

    iii.trigger("state::set", json!({
        "scope": scope(&req.realm_id),
        "key": node.agent_id,
        "value": value,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(serde_json::to_value(&node).unwrap())
}

fn would_create_cycle(nodes: &[HierarchyNode], agent_id: &str, new_parent: &str) -> bool {
    let parent_map: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|n| n.reports_to.as_deref().map(|p| (n.agent_id.as_str(), p)))
        .collect();

    let mut visited = HashSet::new();
    let mut current = new_parent;

    loop {
        if current == agent_id {
            return true;
        }
        if !visited.insert(current) {
            return true;
        }
        match parent_map.get(current) {
            Some(&parent) => current = parent,
            None => return false,
        }
    }
}

async fn load_all(iii: &III, realm_id: &str) -> Result<Vec<HierarchyNode>, IIIError> {
    let result = iii
        .trigger("state::list", json!({ "scope": scope(realm_id) }))
        .await
        .map_err(|e| IIIError::Handler(e.to_string()))?;

    let nodes: Vec<HierarchyNode> = if let Some(arr) = result.as_array() {
        arr.iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect()
    } else {
        vec![]
    };

    Ok(nodes)
}

async fn get_tree(iii: &III, req: TreeRequest) -> Result<Value, IIIError> {
    let nodes = load_all(iii, &req.realm_id).await?;

    let children_map: HashMap<Option<&str>, Vec<&HierarchyNode>> = {
        let mut m: HashMap<Option<&str>, Vec<&HierarchyNode>> = HashMap::new();
        for n in &nodes {
            m.entry(n.reports_to.as_deref()).or_default().push(n);
        }
        m
    };

    fn build_tree<'a>(
        agent_id: &str,
        nodes: &'a [HierarchyNode],
        children_map: &HashMap<Option<&str>, Vec<&'a HierarchyNode>>,
        visited: &mut HashSet<String>,
    ) -> TreeNode {
        let node = nodes.iter().find(|n| n.agent_id == agent_id);
        let title = node.and_then(|n| n.title.clone());
        let caps = node.map(|n| n.capabilities.clone()).unwrap_or_default();
        let rank = node.map(|n| n.rank).unwrap_or(0);

        let reports = if visited.insert(agent_id.to_string()) {
            children_map
                .get(&Some(agent_id))
                .map(|children| {
                    children
                        .iter()
                        .map(|c| build_tree(&c.agent_id, nodes, children_map, visited))
                        .collect()
                })
                .unwrap_or_default()
        } else {
            vec![]
        };

        TreeNode {
            agent_id: agent_id.to_string(),
            title,
            capabilities: caps,
            rank,
            reports,
        }
    }

    if let Some(root_id) = &req.root_agent_id {
        let mut visited = HashSet::new();
        let tree = build_tree(root_id, &nodes, &children_map, &mut visited);
        Ok(serde_json::to_value(tree).unwrap())
    } else {
        let roots: Vec<TreeNode> = children_map
            .get(&None)
            .map(|root_nodes| {
                let mut visited = HashSet::new();
                root_nodes
                    .iter()
                    .map(|n| build_tree(&n.agent_id, &nodes, &children_map, &mut visited))
                    .collect()
            })
            .unwrap_or_default();

        Ok(json!({ "roots": roots }))
    }
}

async fn find_by_capability(iii: &III, req: FindByCapabilityRequest) -> Result<Value, IIIError> {
    let nodes = load_all(iii, &req.realm_id).await?;
    let matches: Vec<&HierarchyNode> = nodes
        .iter()
        .filter(|n| {
            n.capabilities
                .iter()
                .any(|c| c.eq_ignore_ascii_case(&req.capability))
        })
        .collect();

    Ok(json!({
        "matches": matches,
        "count": matches.len(),
    }))
}

async fn get_chain(iii: &III, req: ChainRequest) -> Result<Value, IIIError> {
    let nodes = load_all(iii, &req.realm_id).await?;
    let node_map: HashMap<&str, &HierarchyNode> =
        nodes.iter().map(|n| (n.agent_id.as_str(), n)).collect();

    let mut chain = vec![];
    let mut current = req.agent_id.as_str();
    let mut visited = HashSet::new();

    loop {
        if !visited.insert(current) {
            break;
        }
        if let Some(node) = node_map.get(current) {
            chain.push(serde_json::to_value(*node).unwrap());
            match &node.reports_to {
                Some(parent) => current = parent.as_str(),
                None => break,
            }
        } else {
            break;
        }
    }

    Ok(json!({ "chain": chain }))
}

async fn remove_node(iii: &III, realm_id: &str, agent_id: &str) -> Result<Value, IIIError> {
    iii.trigger("state::delete", json!({
        "scope": scope(realm_id),
        "key": agent_id,
    }))
    .await
    .map_err(|e| IIIError::Handler(e.to_string()))?;

    Ok(json!({ "removed": true }))
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let iii = III::new("ws://localhost:49134");

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "hierarchy::set",
        "Set agent position in hierarchy",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: SetHierarchyRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                set_node(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "hierarchy::tree",
        "Get full org tree for a realm",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: TreeRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                get_tree(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "hierarchy::find",
        "Find agents by capability",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: FindByCapabilityRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                find_by_capability(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "hierarchy::chain",
        "Get chain of command for an agent",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let req: ChainRequest =
                    serde_json::from_value(input).map_err(|e| IIIError::Handler(e.to_string()))?;
                get_chain(&iii, req).await
            }
        },
    );

    let iii_clone = iii.clone();
    iii.register_function_with_description(
        "hierarchy::remove",
        "Remove agent from hierarchy",
        move |input: Value| {
            let iii = iii_clone.clone();
            async move {
                let realm_id = input["realmId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing realmId".into()))?;
                let agent_id = input["agentId"]
                    .as_str()
                    .ok_or_else(|| IIIError::Handler("missing agentId".into()))?;
                remove_node(&iii, realm_id, agent_id).await
            }
        },
    );

    iii.register_trigger("http", "hierarchy::set", json!({ "method": "POST", "path": "/api/hierarchy" }))?;
    iii.register_trigger("http", "hierarchy::tree", json!({ "method": "GET", "path": "/api/hierarchy/:realmId/tree" }))?;
    iii.register_trigger("http", "hierarchy::find", json!({ "method": "GET", "path": "/api/hierarchy/:realmId/find" }))?;
    iii.register_trigger("http", "hierarchy::chain", json!({ "method": "GET", "path": "/api/hierarchy/:realmId/chain/:agentId" }))?;
    iii.register_trigger("http", "hierarchy::remove", json!({ "method": "DELETE", "path": "/api/hierarchy/:realmId/:agentId" }))?;

    tracing::info!("hierarchy worker started");
    tokio::signal::ctrl_c().await?;
    iii.shutdown_async().await;
    Ok(())
}
