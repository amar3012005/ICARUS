"""LlamaIndex vector store backed by mneme.

Implements the three operations LlamaIndex's `BasePydanticVectorStore` contract requires: `add`
(index nodes), `query` (vector search), `delete` (remove by doc id). Node text is stored via
`insert_layered` at layer 0 (memory); the node's own embedding (`node.embedding`) is used
directly -- this store does not compute embeddings, matching every other mneme integration.

Usage:
    from mneme_python import MnemeStore
    from mneme_integrations.llamaindex import MnemeVectorStore

    store = MnemeVectorStore(mneme=MnemeStore("/path/to/data", "my-org", dim=1024))
    store.add(nodes)
    result = store.query(VectorStoreQuery(query_embedding=my_vec, similarity_top_k=5))
"""
from typing import Any, List, Sequence

try:
    from llama_index.core.schema import BaseNode, TextNode
    from llama_index.core.vector_stores.types import (
        BasePydanticVectorStore,
        VectorStoreQuery,
        VectorStoreQueryResult,
    )
    from pydantic import ConfigDict
except ImportError as e:  # pragma: no cover
    raise ImportError(
        "mneme_integrations.llamaindex requires llama-index-core: pip install llama-index-core"
    ) from e


class MnemeVectorStore(BasePydanticVectorStore):
    """A LlamaIndex vector store over a `mneme_python.MnemeStore`.

    KNOWN LIMITATION, STATED RATHER THAN HIDDEN: `delete(ref_doc_id)` removes the single node
    whose mneme slot id matches an internal id->slot map this class keeps in memory. That map is
    NOT persisted -- across a process restart, `delete` by `ref_doc_id` only works for nodes
    added in the current process. Deleting directly by slot id (returned from `add`) always
    works, since that is the engine's own durable identifier.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    stores_text: bool = True
    flat_metadata: bool = False

    def __init__(self, mneme: object, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._mneme = mneme
        self._ref_doc_to_slot: dict[str, int] = {}

    @classmethod
    def class_name(cls) -> str:
        return "MnemeVectorStore"

    @property
    def client(self) -> Any:
        return self._mneme

    def add(self, nodes: Sequence["BaseNode"], **kwargs: Any) -> List[str]:
        ids: List[str] = []
        for node in nodes:
            if node.embedding is None:
                raise ValueError(
                    f"node {node.node_id} has no embedding -- mneme does not compute "
                    "embeddings itself, embed nodes before calling add()"
                )
            slot = self._mneme.insert_layered(node.get_content(), node.embedding, 0, 0)
            self._ref_doc_to_slot[node.node_id] = slot
            ids.append(node.node_id)
        return ids

    def query(self, query: "VectorStoreQuery", **kwargs: Any) -> "VectorStoreQueryResult":
        if query.query_embedding is None:
            raise ValueError("VectorStoreQuery.query_embedding is required (mneme is vector-only)")
        top_k = query.similarity_top_k or 10
        hits = self._mneme.recall(query.query_embedding, top_k)
        nodes = [TextNode(text=h.text, id_=str(h.slot_id)) for h in hits]
        similarities = [h.score for h in hits]
        ids = [str(h.slot_id) for h in hits]
        return VectorStoreQueryResult(nodes=nodes, similarities=similarities, ids=ids)

    def delete(self, ref_doc_id: str, **delete_kwargs: Any) -> None:
        slot = self._ref_doc_to_slot.pop(ref_doc_id, None)
        if slot is not None:
            self._mneme.delete(slot)
